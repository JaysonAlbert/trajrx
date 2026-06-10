import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { CursorEvent, ToolExecutionMetrics } from "../types/index.js";

export interface TerminalRecord {
  command: string;
  elapsed_ms: number;
  started_at?: string;
  ended_at?: string;
  exit_code?: number;
  file: string;
}

export interface EnrichmentContext {
  projectDir: string;
  terminals: TerminalRecord[];
  agentToolsDir: string;
  agentToolsById: Map<string, { path: string; chars: number; tokens: number; mtimeMs: number }>;
  agentToolsTimeline: Array<{ id: string; path: string; chars: number; tokens: number; mtimeMs: number }>;
}

export interface SessionToolStats {
  total_duration_ms: number;
  known_duration_count: number;
  total_output_tokens: number;
  total_output_chars: number;
  by_tool: Record<string, { count: number; total_duration_ms: number; total_output_tokens: number }>;
  slowest: Array<{ step: number; sub_index: number; tool: string; duration_ms: number; output_tokens: number }>;
  largest_outputs: Array<{ step: number; sub_index: number; tool: string; duration_ms: number; output_tokens: number }>;
}

export interface ToolCallRef {
  step: number;
  sub_index: number;
  tool_name: string;
  input: Record<string, unknown>;
}

const AGENT_TOOLS_RE = /agent-tools\/([0-9a-f-]{36})\.txt/i;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const asciiWords = text.replace(/[\u4e00-\u9fff]/g, " ").split(/\s+/).filter(Boolean).length;
  const fromWords = cjk + asciiWords;
  const fromChars = Math.ceil(text.length / 3.5);
  return Math.max(fromWords, fromChars);
}

function normalizeCmd(cmd: string): string {
  return cmd.replace(/\s+/g, " ").trim();
}

function readTextSample(path: string, offset?: number, limit?: number, cap = 512_000): string {
  if (!existsSync(path)) return "";
  try {
    let text = readFileSync(path, "utf-8");
    const off = Number(offset ?? 0);
    const lim = limit != null ? Number(limit) : undefined;
    if (off > 0 || lim != null) {
      const lines = text.split("\n");
      const slice = lines.slice(off, lim != null ? off + lim : undefined);
      text = slice.join("\n");
    }
    return text.slice(0, cap);
  } catch {
    return "";
  }
}

function resolveProjectDir(sourcePath: string): string {
  const marker = `${join("agent-transcripts")}${join("", "")}`;
  const idx = sourcePath.indexOf("/agent-transcripts/");
  if (idx > 0) return sourcePath.slice(0, idx);
  return dirname(dirname(sourcePath));
}

function loadTerminals(projectDir: string): TerminalRecord[] {
  const dir = join(projectDir, "terminals");
  if (!existsSync(dir)) return [];
  const out: TerminalRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".txt")) continue;
    const file = join(dir, name);
    const raw = readFileSync(file, "utf-8");
    const header = raw.split("\n---\n")[0] ?? "";
    const footer = raw.includes("\n---\n") ? raw.split("\n---\n").slice(-1)[0] ?? "" : "";
    const cmdMatch = header.match(/^command:\s*"(.*)"\s*$/m) ?? header.match(/^command:\s*(.+)\s*$/m);
    const elapsedMatch = footer.match(/^elapsed_ms:\s*(\d+)\s*$/m) ?? header.match(/^running_for_ms:\s*(\d+)\s*$/m);
    const startedMatch = header.match(/^started_at:\s*(.+)\s*$/m);
    const endedMatch = footer.match(/^ended_at:\s*(.+)\s*$/m);
    const exitMatch = footer.match(/^exit_code:\s*(-?\d+)\s*$/m);
    if (!cmdMatch) continue;
    out.push({
      command: cmdMatch[1]!.replace(/\\"/g, '"'),
      elapsed_ms: elapsedMatch ? Number(elapsedMatch[1]) : 0,
      started_at: startedMatch?.[1],
      ended_at: endedMatch?.[1],
      exit_code: exitMatch ? Number(exitMatch[1]) : undefined,
      file: name,
    });
  }
  return out.sort((a, b) => (a.started_at ?? "").localeCompare(b.started_at ?? ""));
}

function loadAgentTools(projectDir: string) {
  const dir = join(projectDir, "agent-tools");
  const byId = new Map<string, { path: string; chars: number; tokens: number; mtimeMs: number }>();
  const timeline: Array<{ id: string; path: string; chars: number; tokens: number; mtimeMs: number }> = [];
  if (!existsSync(dir)) {
    return { agentToolsDir: dir, agentToolsById: byId, agentToolsTimeline: timeline };
  }
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".txt")) continue;
    const path = join(dir, name);
    try {
      const st = statSync(path);
      const text = readFileSync(path, "utf-8");
      const id = basename(name, ".txt");
      const entry = { id, path, chars: text.length, tokens: estimateTokens(text), mtimeMs: st.mtimeMs };
      byId.set(id, entry);
      timeline.push(entry);
    } catch {
      /* skip unreadable */
    }
  }
  timeline.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return { agentToolsDir: dir, agentToolsById: byId, agentToolsTimeline: timeline };
}

export function buildEnrichmentContext(sourcePath: string): EnrichmentContext {
  const projectDir = resolveProjectDir(sourcePath);
  return {
    projectDir,
    terminals: loadTerminals(projectDir),
    ...loadAgentTools(projectDir),
  };
}

function matchTerminal(cmd: string, terminals: TerminalRecord[], used: Set<string>): TerminalRecord | null {
  const norm = normalizeCmd(cmd);
  let best: TerminalRecord | null = null;
  let bestScore = 0;
  for (const t of terminals) {
    if (used.has(t.file)) continue;
    const tn = normalizeCmd(t.command);
    if (tn === norm) {
      return t;
    }
    if (tn.includes(norm) || norm.includes(tn)) {
      const score = Math.min(tn.length, norm.length);
      if (score > bestScore) {
        bestScore = score;
        best = t;
      }
    }
  }
  if (best && bestScore > 40) {
    used.add(best.file);
    return best;
  }
  return null;
}

function takeNextAgentTool(ctx: EnrichmentContext, usedIds: Set<string>, afterMs = 0) {
  for (const entry of ctx.agentToolsTimeline) {
    if (usedIds.has(entry.id)) continue;
    if (afterMs && entry.mtimeMs + 1000 < afterMs) continue;
    usedIds.add(entry.id);
    return entry;
  }
  return null;
}

function metricsFromText(text: string, source: ToolExecutionMetrics["output_source"], path?: string): Pick<ToolExecutionMetrics, "output_chars" | "output_tokens" | "output_source" | "output_path"> {
  return {
    output_chars: text.length,
    output_tokens: estimateTokens(text),
    output_source: source,
    output_path: path,
  };
}

function estimateReadDuration(chars: number): number {
  return Math.min(8000, 80 + Math.floor(chars / 400));
}

function estimateMcpDuration(): number {
  return 800;
}

function estimateGrepDuration(chars: number): number {
  return Math.min(5000, 120 + Math.floor(chars / 800));
}

export function enrichToolCall(ref: ToolCallRef, ctx: EnrichmentContext, state: { usedTerminals: Set<string>; usedAgentTools: Set<string> }): ToolExecutionMetrics {
  const name = ref.tool_name;
  const inp = ref.input;

  if (name === "Shell") {
    const cmd = String(inp.command ?? "");
    const terminal = matchTerminal(cmd, ctx.terminals, state.usedTerminals);
    let duration_ms: number | null = null;
    let duration_source: ToolExecutionMetrics["duration_source"] = "unknown";
    let afterMs = 0;
    if (terminal) {
      duration_ms = terminal.elapsed_ms;
      duration_source = "terminal";
      if (terminal.started_at) afterMs = Date.parse(terminal.started_at);
    } else if (inp.block_until_ms != null) {
      duration_ms = Number(inp.block_until_ms);
      duration_source = "estimated";
    }
    const agentOut = takeNextAgentTool(ctx, state.usedAgentTools, afterMs);
    if (agentOut) {
      return {
        duration_ms,
        duration_source,
        ...metricsFromText(readFileSync(agentOut.path, "utf-8").slice(0, 512_000), "agent_tools", agentOut.path),
      };
    }
    const footerText = terminal ? "" : "";
    return {
      duration_ms,
      duration_source,
      output_chars: footerText.length,
      output_tokens: estimateTokens(footerText),
      output_source: terminal ? "terminal_output" : "unknown",
    };
  }

  if (name === "Read") {
    const path = String(inp.path ?? "");
    const agentMatch = path.match(AGENT_TOOLS_RE);
    if (agentMatch) {
      const entry = ctx.agentToolsById.get(agentMatch[1]!);
      if (entry) {
        const text = readTextSample(entry.path, inp.offset as number | undefined, inp.limit as number | undefined);
        return {
          duration_ms: estimateReadDuration(text.length),
          duration_source: "estimated",
          output_chars: text.length,
          output_tokens: estimateTokens(text),
          output_source: "agent_tools",
          output_path: entry.path,
        };
      }
    }
    const text = readTextSample(path, inp.offset as number | undefined, inp.limit as number | undefined);
    return {
      duration_ms: estimateReadDuration(text.length),
      duration_source: "estimated",
      output_chars: text.length,
      output_tokens: estimateTokens(text),
      output_source: existsSync(path) ? "read_file" : "unknown",
      output_path: path,
    };
  }

  if (name === "Grep" || name === "Glob") {
    const agentOut = takeNextAgentTool(ctx, state.usedAgentTools);
    if (agentOut && agentOut.chars > 200) {
      const text = readFileSync(agentOut.path, "utf-8").slice(0, 512_000);
      const dur = estimateGrepDuration(text.length);
      return {
        duration_ms: dur,
        duration_source: "estimated",
        ...metricsFromText(text, "agent_tools", agentOut.path),
      };
    }
    return {
      duration_ms: 250,
      duration_source: "estimated",
      output_chars: 0,
      output_tokens: 0,
      output_source: "estimated",
    };
  }

  if (name === "CallMcpTool") {
    return {
      duration_ms: estimateMcpDuration(),
      duration_source: "estimated",
      output_chars: 1200,
      output_tokens: 300,
      output_source: "estimated",
    };
  }

  if (name === "Write" || name === "StrReplace") {
    const text = String(inp.contents ?? inp.new_string ?? "");
    return {
      duration_ms: 50,
      duration_source: "estimated",
      output_chars: text.length,
      output_tokens: estimateTokens(text),
      output_source: "estimated",
    };
  }

  return {
    duration_ms: 100,
    duration_source: "estimated",
    output_chars: 0,
    output_tokens: 0,
    output_source: "unknown",
  };
}

export function collectToolCallsFromEvents(events: CursorEvent[]): ToolCallRef[] {
  const refs: ToolCallRef[] = [];
  let step = 0;
  let subIndex = 0;
  for (const event of events) {
    if (event.role !== "assistant") continue;
    step++;
    subIndex = 0;
    for (const item of event.message?.content ?? []) {
      if (item.type !== "tool_use") continue;
      subIndex++;
      refs.push({
        step,
        sub_index: subIndex,
        tool_name: String(item.name ?? "unknown"),
        input: (item.input ?? {}) as Record<string, unknown>,
      });
    }
  }
  return refs;
}

export function enrichAllToolCalls(events: CursorEvent[], ctx: EnrichmentContext): Map<string, ToolExecutionMetrics> {
  const refs = collectToolCallsFromEvents(events);
  const state = { usedTerminals: new Set<string>(), usedAgentTools: new Set<string>() };
  const map = new Map<string, ToolExecutionMetrics>();
  for (const ref of refs) {
    map.set(`${ref.step}:${ref.sub_index}`, enrichToolCall(ref, ctx, state));
  }
  return map;
}

export function aggregateSessionToolStats(events: CursorEvent[], metricsMap: Map<string, ToolExecutionMetrics>): SessionToolStats {
  const refs = collectToolCallsFromEvents(events);
  const by_tool: SessionToolStats["by_tool"] = {};
  const rows: SessionToolStats["slowest"] = [];
  let total_duration_ms = 0;
  let known_duration_count = 0;
  let total_output_tokens = 0;
  let total_output_chars = 0;

  for (const ref of refs) {
    const m = metricsMap.get(`${ref.step}:${ref.sub_index}`);
    if (!m) continue;
    if (m.duration_ms != null) {
      total_duration_ms += m.duration_ms;
      known_duration_count++;
    }
    total_output_tokens += m.output_tokens;
    total_output_chars += m.output_chars;
    const bucket = by_tool[ref.tool_name] ?? { count: 0, total_duration_ms: 0, total_output_tokens: 0 };
    bucket.count++;
    bucket.total_duration_ms += m.duration_ms ?? 0;
    bucket.total_output_tokens += m.output_tokens;
    by_tool[ref.tool_name] = bucket;
    rows.push({
      step: ref.step,
      sub_index: ref.sub_index,
      tool: ref.tool_name,
      duration_ms: m.duration_ms ?? 0,
      output_tokens: m.output_tokens,
    });
  }

  const slowest = [...rows].sort((a, b) => b.duration_ms - a.duration_ms).slice(0, 10);
  const largest_outputs = [...rows].sort((a, b) => b.output_tokens - a.output_tokens).slice(0, 10);

  return {
    total_duration_ms,
    known_duration_count,
    total_output_tokens,
    total_output_chars,
    by_tool,
    slowest,
    largest_outputs,
  };
}

export function formatDuration(ms: number | null): string {
  if (ms == null) return "unknown";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60_000);
  const sec = Math.round((ms % 60_000) / 1000);
  return `${min}m ${sec}s`;
}

export function formatTokenCount(n: number): string {
  return n.toLocaleString("en-US");
}
