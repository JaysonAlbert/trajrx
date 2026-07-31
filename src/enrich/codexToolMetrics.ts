import { estimateTokens } from "./toolMetrics.js";
import type { ParsedCodexSession } from "../types/codex.js";
import type { ToolExecutionMetrics } from "../types/index.js";
import { flattenCodexSteps } from "../ir/codexParser.js";

const WALL_TIME_RE = /Wall time:\s*([0-9.]+)\s*seconds?/i;
const TOKEN_COUNT_RE = /Original token count:\s*(\d+)/i;
const SESSION_ID_RE = /session ID\s+(\d+)/i;
const RUNNING_RE = /Process (?:still )?running/i;
const EXIT_RE = /Process exited/i;

export interface CodexSessionToolStats {
  total_duration_ms: number;
  known_duration_count: number;
  total_output_tokens: number;
  total_output_chars: number;
  background_sessions: Array<{
    session_id: number;
    command: string;
    poll_count: number;
    total_wall_ms: number;
    first_step: number;
    aggregated_ms?: number;
  }>;
  by_tool: Record<string, { count: number; total_duration_ms: number; total_output_tokens: number }>;
  slowest: Array<{ step: number; sub_index: number; tool: string; duration_ms: number; output_tokens: number; command: string }>;
  largest_outputs: Array<{ step: number; sub_index: number; tool: string; duration_ms: number; output_tokens: number; command: string }>;
  thinking_gaps_ms: Array<{ after_step: number; gap_ms: number; label: string }>;
}

interface SessionMember {
  key: string;
  name: string;
  step: number;
  toolIndex: number;
  label: string;
  metrics: ToolExecutionMetrics;
}

export function parseCodexOutputMetrics(output: string, input: Record<string, unknown>): ToolExecutionMetrics {
  const wallMatch = WALL_TIME_RE.exec(output);
  const tokenMatch = TOKEN_COUNT_RE.exec(output);
  const yieldMs = input.yield_time_ms != null ? Number(input.yield_time_ms) : null;

  let duration_ms: number | null = null;
  let duration_source: ToolExecutionMetrics["duration_source"] = "unknown";
  if (wallMatch) {
    duration_ms = Math.round(Number(wallMatch[1]) * 1000);
    duration_source = "terminal";
  } else if (yieldMs != null && RUNNING_RE.test(output)) {
    duration_ms = yieldMs;
    duration_source = "estimated";
  } else if (yieldMs != null && EXIT_RE.test(output)) {
    duration_ms = yieldMs;
    duration_source = "estimated";
  }

  const output_chars = output.length;
  const output_tokens = tokenMatch ? Number(tokenMatch[1]) : estimateTokens(output.slice(0, 512_000));

  return {
    duration_ms,
    duration_source,
    output_chars,
    output_tokens,
    output_source: output ? "terminal_output" : "unknown",
  };
}

export function execCommandLabel(input: Record<string, unknown>): string {
  const cmd = String(input.cmd ?? input.command ?? "");
  return cmd.replace(/\s+/g, " ").trim().slice(0, 500);
}

/** Extract rg/grep search pattern from a shell command (supports quoted patterns with pipes). */
export function extractRgPattern(cmd: string): string | undefined {
  const norm = cmd.replace(/\s+/g, " ").trim();
  const quoted = norm.match(/\b(?:rg|grep)\b(?:\s+-[^\s]+)*\s+(["'])([\s\S]*?)\1/);
  if (quoted?.[2]) return quoted[2].slice(0, 200);
  const bare = norm.match(/\b(?:rg|grep)\b(?:\s+-[^\s]+)*\s+([^\s-][^\s]*)/);
  if (bare?.[1] && !bare[1].startsWith("-")) return bare[1].slice(0, 200);
  return undefined;
}

/** Extract file path from sed/cat/head/tail style reads. */
export function extractReadPath(cmd: string): string | undefined {
  const norm = cmd.replace(/\s+/g, " ").trim();
  const sedTail = norm.match(/\b(?:sed|cat|head|tail)\b[\s\S]*?\s(\/[^\s;|&]+|\.\/[^\s;|&]+|[^\s;|&]+\.[a-z0-9]+)/i);
  if (sedTail?.[1]) return sedTail[1];
  return undefined;
}

export function classifyExecCommand(cmd: string): {
  shell_cmd?: string;
  grep_pattern?: string;
  read_path?: string;
} {
  const norm = cmd.replace(/\s+/g, " ").trim();
  return {
    shell_cmd: norm,
    grep_pattern: extractRgPattern(norm),
    read_path: extractReadPath(norm),
  };
}

function extractSessionId(output: string, input: Record<string, unknown>): number | undefined {
  if (typeof input.session_id === "number") return input.session_id;
  const m = SESSION_ID_RE.exec(output);
  return m ? Number(m[1]) : undefined;
}

function aggregateBackgroundSessions(
  membersBySession: Map<number, SessionMember[]>,
  metricsMap: Map<string, ToolExecutionMetrics>
): Map<number, number> {
  const aggregatedMs = new Map<number, number>();
  for (const [sid, members] of membersBySession) {
    if (members.length < 2) continue;
    const polls = members.filter((m) => m.name === "write_stdin");
    if (!polls.length) continue;

    const execs = members.filter((m) => m.name === "exec_command");
    const totalWall = members.reduce((sum, m) => sum + (m.metrics.duration_ms ?? 0), 0);
    const totalTokens = members.reduce((sum, m) => sum + m.metrics.output_tokens, 0);
    const totalChars = members.reduce((sum, m) => sum + m.metrics.output_chars, 0);
    aggregatedMs.set(sid, totalWall);

    const primary = execs[0] ?? polls[0];
    if (!primary) continue;

    metricsMap.set(primary.key, {
      ...primary.metrics,
      duration_ms: totalWall,
      duration_source: "terminal",
      output_tokens: totalTokens,
      output_chars: totalChars,
      output_source: "terminal_output",
    });

    for (const m of members) {
      if (m.key === primary.key) continue;
      metricsMap.set(m.key, { ...m.metrics, duration_ms: 0, duration_source: "unknown" });
    }
  }
  return aggregatedMs;
}

function rebuildTotals(
  steps: ReturnType<typeof flattenCodexSteps>["steps"],
  metricsMap: Map<string, ToolExecutionMetrics>,
  slowest: CodexSessionToolStats["slowest"]
) {
  const by_tool: CodexSessionToolStats["by_tool"] = {};
  let total_duration_ms = 0;
  let known_duration_count = 0;
  let total_output_tokens = 0;
  let total_output_chars = 0;

  for (const step of steps) {
    let toolIndex = 0;
    for (const tool of step.tools) {
      toolIndex++;
      const key = `${step.step_index}:t${toolIndex}`;
      const metrics = metricsMap.get(key)!;
      const label = tool.name === "exec_command" ? execCommandLabel(tool.input) : tool.name;

      if (metrics.duration_ms != null && metrics.duration_ms > 0) {
        total_duration_ms += metrics.duration_ms;
        known_duration_count++;
      }
      total_output_tokens += metrics.output_tokens;
      total_output_chars += metrics.output_chars;

      const bucket = by_tool[tool.name] ?? { count: 0, total_duration_ms: 0, total_output_tokens: 0 };
      bucket.count++;
      bucket.total_duration_ms += metrics.duration_ms ?? 0;
      bucket.total_output_tokens += metrics.output_tokens;
      by_tool[tool.name] = bucket;

      const idx = slowest.findIndex((r) => r.step === step.step_index && r.sub_index === toolIndex);
      if (idx >= 0) {
        slowest[idx]!.duration_ms = metrics.duration_ms ?? 0;
        slowest[idx]!.output_tokens = metrics.output_tokens;
        slowest[idx]!.command = label === "exec_command" ? execCommandLabel(tool.input) : slowest[idx]!.command;
      }
    }
  }

  return { by_tool, total_duration_ms, known_duration_count, total_output_tokens, total_output_chars };
}

export function enrichCodexSession(session: ParsedCodexSession): {
  metricsMap: Map<string, ToolExecutionMetrics>;
  sessionToolStats: CodexSessionToolStats;
} {
  const { steps } = flattenCodexSteps(session);
  const metricsMap = new Map<string, ToolExecutionMetrics>();
  const slowest: CodexSessionToolStats["slowest"] = [];
  const largest_outputs: CodexSessionToolStats["largest_outputs"] = [];
  const background = new Map<number, { command: string; poll_count: number; total_wall_ms: number; first_step: number }>();
  const sessionMembers = new Map<number, SessionMember[]>();

  for (const step of steps) {
    let toolIndex = 0;
    for (const tool of step.tools) {
      toolIndex++;
      const key = `${step.step_index}:t${toolIndex}`;
      const metrics = parseCodexOutputMetrics(tool.output, tool.input);
      metricsMap.set(key, metrics);

      const label = tool.name === "exec_command" ? execCommandLabel(tool.input) : `${tool.name}(${JSON.stringify(tool.input).slice(0, 80)})`;

      slowest.push({
        step: step.step_index,
        sub_index: toolIndex,
        tool: tool.name,
        duration_ms: metrics.duration_ms ?? 0,
        output_tokens: metrics.output_tokens,
        command: label,
      });
      largest_outputs.push({
        step: step.step_index,
        sub_index: toolIndex,
        tool: tool.name,
        duration_ms: metrics.duration_ms ?? 0,
        output_tokens: metrics.output_tokens,
        command: label,
      });

      const sid = extractSessionId(tool.output, tool.input);
      if (sid != null) {
        const list = sessionMembers.get(sid) ?? [];
        list.push({ key, name: tool.name, step: step.step_index, toolIndex, label, metrics: { ...metrics } });
        sessionMembers.set(sid, list);

        const existing = background.get(sid) ?? {
          command: tool.name === "exec_command" ? execCommandLabel(tool.input) : `session ${sid}`,
          poll_count: 0,
          total_wall_ms: 0,
          first_step: step.step_index,
        };
        existing.poll_count += tool.name === "write_stdin" ? 1 : 0;
        existing.total_wall_ms += metrics.duration_ms ?? 0;
        background.set(sid, existing);
      }
    }
  }

  const aggregatedMs = aggregateBackgroundSessions(sessionMembers, metricsMap);
  const totals = rebuildTotals(steps, metricsMap, slowest);

  const thinking_gaps_ms: CodexSessionToolStats["thinking_gaps_ms"] = [];
  for (let i = 1; i < steps.length; i++) {
    if (steps[i]!.user_turn !== steps[i - 1]!.user_turn) continue;
    const prev = new Date(steps[i - 1]!.timestamp).getTime();
    const cur = new Date(steps[i]!.timestamp).getTime();
    const gap = cur - prev;
    if (gap >= 60_000) {
      thinking_gaps_ms.push({
        after_step: steps[i - 1]!.step_index,
        gap_ms: gap,
        label: steps[i]!.commentary.slice(0, 120) || "(tool batch)",
      });
    }
  }

  slowest.sort((a, b) => b.duration_ms - a.duration_ms);
  largest_outputs.sort((a, b) => b.output_tokens - a.output_tokens);

  return {
    metricsMap,
    sessionToolStats: {
      ...totals,
      background_sessions: [...background.entries()].map(([session_id, v]) => ({
        session_id,
        ...v,
        aggregated_ms: aggregatedMs.get(session_id) ?? v.total_wall_ms,
      })),
      slowest: slowest.slice(0, 15),
      largest_outputs: largest_outputs.slice(0, 15),
      thinking_gaps_ms,
    },
  };
}
