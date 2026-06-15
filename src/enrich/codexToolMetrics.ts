import { estimateTokens } from "./toolMetrics.js";
import type { CodexToolCall, ParsedCodexSession } from "../types/codex.js";
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
  }>;
  by_tool: Record<string, { count: number; total_duration_ms: number; total_output_tokens: number }>;
  slowest: Array<{ step: number; sub_index: number; tool: string; duration_ms: number; output_tokens: number; command: string }>;
  largest_outputs: Array<{ step: number; sub_index: number; tool: string; duration_ms: number; output_tokens: number; command: string }>;
  thinking_gaps_ms: Array<{ after_step: number; gap_ms: number; label: string }>;
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

export function classifyExecCommand(cmd: string): {
  shell_cmd?: string;
  grep_pattern?: string;
  read_path?: string;
} {
  const norm = cmd.replace(/\s+/g, " ").trim();
  const rg = norm.match(/^(?:rg|grep)\s+(?:-[^\s]+\s+)*["']?([^"'\s]+)["']?/);
  if (rg) return { grep_pattern: rg[1], shell_cmd: norm };
  const sed = norm.match(/^(?:sed|cat|head|tail)\s+.*?['"]?([^'"\s]+\.(?:md|js|ts|tsx|yml|yaml|py|json))['"]?/i);
  if (sed) return { read_path: sed[1], shell_cmd: norm };
  return { shell_cmd: norm };
}

function extractSessionId(output: string, input: Record<string, unknown>): number | undefined {
  if (typeof input.session_id === "number") return input.session_id;
  const m = SESSION_ID_RE.exec(output);
  return m ? Number(m[1]) : undefined;
}

export function enrichCodexSession(session: ParsedCodexSession): {
  metricsMap: Map<string, ToolExecutionMetrics>;
  sessionToolStats: CodexSessionToolStats;
} {
  const { steps } = flattenCodexSteps(session);
  const metricsMap = new Map<string, ToolExecutionMetrics>();
  const by_tool: CodexSessionToolStats["by_tool"] = {};
  const slowest: CodexSessionToolStats["slowest"] = [];
  const largest_outputs: CodexSessionToolStats["largest_outputs"] = [];
  const background = new Map<number, { command: string; poll_count: number; total_wall_ms: number; first_step: number }>();

  let total_duration_ms = 0;
  let known_duration_count = 0;
  let total_output_tokens = 0;
  let total_output_chars = 0;

  for (const step of steps) {
    let toolIndex = 0;
    for (const tool of step.tools) {
      toolIndex++;
      const key = `${step.step_index}:t${toolIndex}`;
      const metrics = parseCodexOutputMetrics(tool.output, tool.input);
      metricsMap.set(key, metrics);

      const label = tool.name === "exec_command" ? execCommandLabel(tool.input) : `${tool.name}(${JSON.stringify(tool.input).slice(0, 80)})`;
      if (metrics.duration_ms != null) {
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

  const thinking_gaps_ms: CodexSessionToolStats["thinking_gaps_ms"] = [];
  for (let i = 1; i < steps.length; i++) {
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
      total_duration_ms,
      known_duration_count,
      total_output_tokens,
      total_output_chars,
      background_sessions: [...background.entries()].map(([session_id, v]) => ({ session_id, ...v })),
      by_tool,
      slowest: slowest.slice(0, 15),
      largest_outputs: largest_outputs.slice(0, 15),
      thinking_gaps_ms,
    },
  };
}
