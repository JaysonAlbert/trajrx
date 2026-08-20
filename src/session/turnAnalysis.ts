import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { getCodexHome, getCursorHome, type TranscriptSource } from "../config.js";
import { countToolInputStats } from "../enrich/toolInputMetrics.js";
import { estimateTokens } from "../enrich/toolMetrics.js";
import {
  extractSubagentEfficiency,
  type SubagentActivation,
  type SubagentEfficiencyEvidence,
  type SubagentSessionEvidence,
} from "./subagentEfficiency.js";

type JsonObject = Record<string, unknown>;
type TimeSource = "internal_create_time" | "outer_timestamp" | "hook_state_wall_clock";
type ToolTimeSource = "internal_create_time" | "outer_timestamp" | "unavailable";

export interface BoundedList<T> {
  total: number;
  returned: number;
  truncated: boolean;
  items: T[];
}

export interface ToolCallEvidence {
  sequence: number;
  name: string;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  duration_source: ToolTimeSource;
  completed: boolean | null;
  failed: boolean | null;
  input_preview: string;
  input_chars: number;
  param_count: number;
  output_chars: number | null;
  output_tokens: number | null;
}

export interface RepeatedCallEvidence {
  fingerprint: string;
  name: string;
  input_preview: string;
  count: number;
  sequences: number[];
}

export type BoundedSubagentSessionEvidence = Omit<SubagentSessionEvidence, "activations"> & {
  activations: BoundedList<SubagentActivation>;
};

export type BoundedSubagentEfficiencyEvidence = Omit<SubagentEfficiencyEvidence, "subagents"> & {
  subagents: BoundedList<BoundedSubagentSessionEvidence>;
};

export interface TurnAnalysisEvidence {
  schema: "trajrx_turn_analysis_v1";
  schema_version: 1;
  source: TranscriptSource;
  selection: {
    mode: "codex_hook_turn" | "cursor_hook_generation";
    request_id: string;
    requested_at: string;
    conversation_id: string | null;
    turn_id: string | null;
    generation_id: string | null;
    hook_state_path: string;
    session_path: string;
  };
  boundary: {
    started_at: string;
    ended_at: string;
    start_time_source: TimeSource;
    end_time_source: TimeSource;
    user_preview: string;
    final_preview: string;
  };
  elapsed: {
    total_ms: number;
    tool_wait_union_ms: number | null;
    tool_wait_sum_ms: number | null;
    other_observed_ms: number | null;
  };
  tools: {
    call_count: number;
    failed_count: number | null;
    incomplete_count: number | null;
    total_input_chars: number;
    total_param_count: number;
    total_output_chars: number | null;
    total_output_tokens: number | null;
    longest_calls: BoundedList<ToolCallEvidence> | null;
    failed_calls: BoundedList<ToolCallEvidence> | null;
    repeated_calls: BoundedList<RepeatedCallEvidence>;
    largest_inputs: BoundedList<ToolCallEvidence>;
    largest_outputs: BoundedList<ToolCallEvidence> | null;
  };
  compactions: { count: number | null; timestamps: string[] };
  longest_observed_gaps: BoundedList<{
    started_at: string;
    ended_at: string;
    duration_ms: number;
    from: string;
    to: string;
  }> | null;
  assistant_milestones: BoundedList<{
    sequence: number;
    timestamp: string | null;
    phase: string;
    text: string;
  }>;
  subagent_efficiency: BoundedSubagentEfficiencyEvidence;
  unavailable: string[];
}

export interface TurnAnalysisOptions {
  client: TranscriptSource;
  sessionPath?: string;
  hookStatePath?: string;
  codexHome?: string;
  cursorHome?: string;
  top?: number;
}

interface ObservedTime {
  ms: number;
  iso: string;
  source: Exclude<ToolTimeSource, "unavailable">;
}

interface CodexCall extends ToolCallEvidence {
  normalizedInput: string;
}

interface HookBoundary {
  statePath: string;
  client: TranscriptSource;
  conversationId: string;
  turnId: string;
  requestId: string;
  startedAt: string;
  endedAt: string;
  startedMs: number;
  endedMs: number;
  totalMs: number;
}

const TOOL_CALL_TYPES = new Set(["custom_tool_call", "function_call"]);
const TOOL_OUTPUT_TYPES = new Set(["custom_tool_call_output", "function_call_output"]);
const SENSITIVE_KEY_RE = /token|password|passwd|secret|authorization|api[-_]?key/i;
const CURSOR_INITIAL_TAIL = 2 * 1024 * 1024;
const CURSOR_MAX_TAIL = 16 * 1024 * 1024;

export function analyzeTurn(options: TurnAnalysisOptions): TurnAnalysisEvidence {
  const top = options.top ?? 10;
  if (!Number.isInteger(top) || top <= 0) throw new Error("--top must be a positive integer");
  return options.client === "cursor"
    ? analyzeCursorTurn(options, top)
    : analyzeCodexTurn(options, top);
}

function analyzeCodexTurn(options: TurnAnalysisOptions, top: number): TurnAnalysisEvidence {
  if (!options.hookStatePath) throw new Error("--hook-state is required for --client codex");
  const hook = readHookState(options.hookStatePath, "codex");
  const sessionPath = options.sessionPath
    ? requireFile(options.sessionPath, "Codex rollout")
    : resolveCodexSession(hook.conversationId, options.codexHome ?? getCodexHome());
  const records = readJsonl(sessionPath);
  validateCodexConversation(records, hook.conversationId);
  const startIndexes = records
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => isTaskStarted(record, hook.turnId))
    .map(({ index }) => index);
  if (startIndexes.length !== 1) {
    throw new Error(
      startIndexes.length === 0
        ? `no Codex task_started found for Hook turnId=${JSON.stringify(hook.turnId)}`
        : `multiple Codex task_started records found for Hook turnId=${JSON.stringify(hook.turnId)}`,
    );
  }
  const taskStartedIndex = startIndexes[0]!;
  const finalIndexes = records
    .map((record, index) => ({ record, index }))
    .filter(({ record, index }) =>
      index > taskStartedIndex && isAssistantFinal(record) && observedTime(record).ms <= hook.endedMs
    )
    .map(({ index }) => index);
  if (!finalIndexes.length) throw new Error("no completed assistant final exists before the selected Codex Hook request");
  const finalIndex = finalIndexes.at(-1)!;
  const userIndex = records.findIndex(
    (record, index) => index > taskStartedIndex && index <= finalIndex && isUserMessage(record),
  );
  if (userIndex < 0) throw new Error("no user message bounds the selected Codex Hook turn");

  const selected = records.slice(userIndex, finalIndex + 1);
  const start = observedTime(records[userIndex]!);
  const end = observedTime(records[finalIndex]!);
  ensureMonotonic(start, end, "Codex turn boundary");
  const totalMs = Math.round(end.ms - start.ms);
  const toolData = codexToolEvidence(selected, top);
  const compactionTimes = selected
    .filter(isCompaction)
    .map((record) => observedTime(record).iso);
  const milestones = selected
    .filter(isAssistantMessage)
    .map((record, index) => ({
      sequence: index + 1,
      timestamp: observedTime(record).iso,
      phase: String(asObject(record.payload)?.phase ?? "default"),
      text: redactPreview(messageText(record), 240),
    }))
    .filter((item) => item.text);
  const gaps = observedGaps(selected);

  return {
    schema: "trajrx_turn_analysis_v1",
    schema_version: 1,
    source: "codex",
    selection: {
      mode: "codex_hook_turn",
      request_id: hook.requestId,
      requested_at: hook.endedAt,
      conversation_id: hook.conversationId,
      turn_id: hook.turnId,
      generation_id: null,
      hook_state_path: hook.statePath,
      session_path: sessionPath,
    },
    boundary: {
      started_at: start.iso,
      ended_at: end.iso,
      start_time_source: start.source,
      end_time_source: end.source,
      user_preview: redactPreview(messageText(records[userIndex]!), 240),
      final_preview: redactPreview(messageText(records[finalIndex]!), 240),
    },
    elapsed: {
      total_ms: totalMs,
      tool_wait_union_ms: toolData.waitUnionMs,
      tool_wait_sum_ms: toolData.waitSumMs,
      other_observed_ms: Math.max(0, totalMs - toolData.waitUnionMs),
    },
    tools: toolData.summary,
    compactions: { count: compactionTimes.length, timestamps: compactionTimes },
    longest_observed_gaps: bounded(gaps.sort((a, b) => b.duration_ms - a.duration_ms), top),
    assistant_milestones: bounded(milestones, top),
    subagent_efficiency: boundSubagentEvidence(
      extractSubagentEfficiency(sessionPath, "codex", {
        startedAt: start.iso,
        endedAt: end.iso,
      }),
      top,
    ),
    unavailable: [],
  };
}

function analyzeCursorTurn(options: TurnAnalysisOptions, top: number): TurnAnalysisEvidence {
  if (!options.hookStatePath) throw new Error("--hook-state is required for --client cursor");
  const hook = readHookState(options.hookStatePath, "cursor");
  const sessionPath = options.sessionPath
    ? requireFile(options.sessionPath, "Cursor transcript")
    : resolveCursorSession(options.cursorHome ?? getCursorHome(), hook.conversationId);
  if (basename(sessionPath, ".jsonl") !== hook.conversationId || basename(dirname(sessionPath)) !== hook.conversationId) {
    throw new Error("Cursor transcript path does not match Hook conversationId");
  }
  const turn = loadCursorTargetTurn(sessionPath);
  const userPreview = cursorUserText(turn);
  const assistantTexts = turn.flatMap((record) =>
    record.role === "assistant" ? cursorTextItems(record) : [],
  );
  if (!userPreview) throw new Error("completed Cursor turn has no user message");
  if (!assistantTexts.length) throw new Error("completed Cursor turn has no assistant text");
  const calls = cursorCalls(turn);
  const repeated = repeatedCalls(calls, top);
  const largestInputs = bounded(
    [...calls].sort((a, b) => b.input_chars - a.input_chars).map(stripNormalizedInput),
    top,
  );
  const unavailable = [
    "elapsed.tool_wait_union_ms",
    "elapsed.tool_wait_sum_ms",
    "elapsed.other_observed_ms",
    "tools.failed_count",
    "tools.incomplete_count",
    "tools.total_output_chars",
    "tools.total_output_tokens",
    "tools.longest_calls",
    "tools.failed_calls",
    "tools.largest_outputs",
    "tools.largest_inputs.items[*].started_at",
    "tools.largest_inputs.items[*].ended_at",
    "tools.largest_inputs.items[*].duration_ms",
    "tools.largest_inputs.items[*].completed",
    "tools.largest_inputs.items[*].failed",
    "tools.largest_inputs.items[*].output_chars",
    "tools.largest_inputs.items[*].output_tokens",
    "compactions.count",
    "longest_observed_gaps",
    "assistant_milestones.items[*].timestamp",
  ];
  return {
    schema: "trajrx_turn_analysis_v1",
    schema_version: 1,
    source: "cursor",
    selection: {
      mode: "cursor_hook_generation",
      request_id: hook.requestId,
      requested_at: hook.endedAt,
      conversation_id: hook.conversationId,
      turn_id: null,
      generation_id: hook.turnId,
      hook_state_path: hook.statePath,
      session_path: sessionPath,
    },
    boundary: {
      started_at: hook.startedAt,
      ended_at: hook.endedAt,
      start_time_source: "hook_state_wall_clock",
      end_time_source: "hook_state_wall_clock",
      user_preview: redactPreview(userPreview, 240),
      final_preview: redactPreview(assistantTexts.at(-1)!, 240),
    },
    elapsed: {
      total_ms: hook.totalMs,
      tool_wait_union_ms: null,
      tool_wait_sum_ms: null,
      other_observed_ms: null,
    },
    tools: {
      call_count: calls.length,
      failed_count: null,
      incomplete_count: null,
      total_input_chars: calls.reduce((sum, item) => sum + item.input_chars, 0),
      total_param_count: calls.reduce((sum, item) => sum + item.param_count, 0),
      total_output_chars: null,
      total_output_tokens: null,
      longest_calls: null,
      failed_calls: null,
      repeated_calls: repeated,
      largest_inputs: largestInputs,
      largest_outputs: null,
    },
    compactions: { count: null, timestamps: [] },
    longest_observed_gaps: null,
    assistant_milestones: bounded(
      assistantTexts.map((text, index) => ({
        sequence: index + 1,
        timestamp: null,
        phase: "assistant",
        text: redactPreview(text, 240),
      })),
      top,
    ),
    subagent_efficiency: boundSubagentEvidence(
      extractSubagentEfficiency(sessionPath, "cursor", {
        startedAt: hook.startedAt,
        endedAt: hook.endedAt,
      }),
      top,
    ),
    unavailable,
  };
}

function codexToolEvidence(records: JsonObject[], top: number): {
  waitUnionMs: number;
  waitSumMs: number;
  summary: TurnAnalysisEvidence["tools"];
} {
  const outputs = new Map<string, Array<{ record: JsonObject; index: number }>>();
  records.forEach((record, index) => {
    const payload = asObject(record.payload);
    if (!payload || !TOOL_OUTPUT_TYPES.has(String(payload.type ?? ""))) return;
    const callId = stringValue(payload.call_id ?? payload.callId);
    if (!callId) return;
    const list = outputs.get(callId) ?? [];
    list.push({ record, index });
    outputs.set(callId, list);
  });

  const calls: CodexCall[] = [];
  const intervals: Array<[number, number]> = [];
  records.forEach((record, recordIndex) => {
    const payload = asObject(record.payload);
    if (!payload || !TOOL_CALL_TYPES.has(String(payload.type ?? ""))) return;
    const callId = stringValue(payload.call_id ?? payload.callId);
    const output = (outputs.get(callId ?? "") ?? []).find((item) => item.index >= recordIndex)?.record;
    const start = outerTime(record);
    const end = output ? outerTime(output) : null;
    if (end) ensureMonotonic(start, end, `tool call ${callId ?? "unknown"}`);
    if (end) intervals.push([start.ms, end.ms]);
    const name = String(payload.name ?? "unknown");
    const rawInput = payload.arguments ?? payload.input ?? {};
    const inputObject = normalizeInput(rawInput);
    const serializedInput = stableString(rawInput);
    const inputStats = countToolInputStats(name, inputObject);
    const rawOutput = output ? asObject(output.payload)?.output ?? asObject(output.payload)?.content ?? "" : null;
    const outputText = rawOutput === null ? null : stableString(rawOutput);
    calls.push({
      sequence: calls.length + 1,
      name,
      started_at: start.iso,
      ended_at: end?.iso ?? null,
      duration_ms: end ? Math.round(end.ms - start.ms) : null,
      duration_source: "outer_timestamp",
      completed: Boolean(end),
      failed: output
        ? failedOutput(asObject(output.payload) ?? output, usesSerializedExecutionEnvelope(name))
        : false,
      input_preview: redactPreview(serializedInput, 180),
      input_chars: inputStats.input_chars,
      param_count: inputStats.param_count,
      output_chars: outputText?.length ?? null,
      output_tokens: outputText === null ? null : estimateTokens(outputText),
      normalizedInput: normalizeWhitespace(serializedInput),
    });
  });
  const publicCalls = calls.map(stripNormalizedInput);
  const waitSumMs = calls.reduce((sum, item) => sum + (item.duration_ms ?? 0), 0);
  const failed = publicCalls.filter((item) => item.failed);
  const totalOutputChars = calls.reduce((sum, item) => sum + (item.output_chars ?? 0), 0);
  const totalOutputTokens = calls.reduce((sum, item) => sum + (item.output_tokens ?? 0), 0);
  return {
    waitUnionMs: intervalUnionMs(intervals),
    waitSumMs,
    summary: {
      call_count: calls.length,
      failed_count: failed.length,
      incomplete_count: calls.filter((item) => !item.completed).length,
      total_input_chars: calls.reduce((sum, item) => sum + item.input_chars, 0),
      total_param_count: calls.reduce((sum, item) => sum + item.param_count, 0),
      total_output_chars: totalOutputChars,
      total_output_tokens: totalOutputTokens,
      longest_calls: bounded(
        [...publicCalls].sort((a, b) => (b.duration_ms ?? -1) - (a.duration_ms ?? -1)),
        top,
      ),
      failed_calls: bounded(failed, top),
      repeated_calls: repeatedCalls(calls, top),
      largest_inputs: bounded([...publicCalls].sort((a, b) => b.input_chars - a.input_chars), top),
      largest_outputs: bounded(
        [...publicCalls].sort((a, b) => (b.output_tokens ?? -1) - (a.output_tokens ?? -1)),
        top,
      ),
    },
  };
}

function cursorCalls(turn: JsonObject[]): CodexCall[] {
  const calls: CodexCall[] = [];
  for (const record of turn) {
    if (record.role !== "assistant") continue;
    for (const item of cursorContent(record)) {
      if (item.type !== "tool_use") continue;
      const name = String(item.name ?? "unknown");
      const rawInput = item.input ?? {};
      const inputObject = normalizeInput(rawInput);
      const serializedInput = stableString(rawInput);
      const stats = countToolInputStats(name, inputObject);
      calls.push({
        sequence: calls.length + 1,
        name,
        started_at: null,
        ended_at: null,
        duration_ms: null,
        duration_source: "unavailable",
        completed: null,
        failed: null,
        input_preview: redactPreview(serializedInput, 180),
        input_chars: stats.input_chars,
        param_count: stats.param_count,
        output_chars: null,
        output_tokens: null,
        normalizedInput: normalizeWhitespace(serializedInput),
      });
    }
  }
  return calls;
}

function repeatedCalls(calls: CodexCall[], top: number): BoundedList<RepeatedCallEvidence> {
  const groups = new Map<string, CodexCall[]>();
  for (const call of calls) {
    const digest = createHash("sha256").update(`${call.name}\0${call.normalizedInput}`).digest("hex");
    const rows = groups.get(digest) ?? [];
    rows.push(call);
    groups.set(digest, rows);
  }
  const repeated = [...groups.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([fingerprint, rows]) => ({
      fingerprint,
      name: rows[0]!.name,
      input_preview: rows[0]!.input_preview,
      count: rows.length,
      sequences: rows.map((row) => row.sequence).slice(0, top),
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return bounded(repeated, top);
}

function stripNormalizedInput(call: CodexCall): ToolCallEvidence {
  const { normalizedInput: _ignored, ...publicCall } = call;
  return publicCall;
}

function observedGaps(records: JsonObject[]): Array<{
  started_at: string;
  ended_at: string;
  duration_ms: number;
  from: string;
  to: string;
}> {
  const activity = records
    .filter((record) => record.type === "response_item" || isCompaction(record))
    .map((record) => ({ record, time: observedTime(record) }))
    .sort((left, right) => left.time.ms - right.time.ms);
  const gaps = [];
  for (let index = 1; index < activity.length; index++) {
    const before = activity[index - 1]!;
    const after = activity[index]!;
    const start = before.time;
    const end = after.time;
    gaps.push({
      started_at: start.iso,
      ended_at: end.iso,
      duration_ms: Math.round(end.ms - start.ms),
      from: describeRecord(before.record),
      to: describeRecord(after.record),
    });
  }
  return gaps;
}

function readHookState(path: string, expectedClient: TranscriptSource): HookBoundary {
  const statePath = ["start.json", "request.json"].includes(basename(path)) ? dirname(path) : path;
  const start = readJsonObject(join(statePath, "start.json"), "harness_agent_hook_turn_v1");
  const request = readJsonObject(join(statePath, "request.json"), "harness_agent_hook_request_v1");
  const identities = [start.client, start.conversationId, start.turnId];
  if (
    identities[0] !== expectedClient
    || identities[0] !== request.client
    || identities[1] !== request.conversationId
    || identities[2] !== request.turnId
  ) {
    throw new Error(`${expectedClient} Hook start/request identity does not match`);
  }
  const conversationId = stringValue(identities[1]);
  const turnId = stringValue(identities[2]);
  const requestId = stringValue(request.requestId);
  if (!conversationId || !turnId || !requestId) throw new Error(`${expectedClient} Hook state is missing identity fields`);
  const startedNs = positiveNumber(start.startedWallNs, "startedWallNs");
  const endedNs = positiveNumber(request.requestedWallNs, "requestedWallNs");
  if (endedNs < startedNs) throw new Error("Cursor Hook request precedes generation start");
  return {
    statePath,
    client: expectedClient,
    conversationId,
    turnId,
    requestId,
    startedAt: wallNsIso(startedNs),
    endedAt: wallNsIso(endedNs),
    startedMs: startedNs / 1_000_000,
    endedMs: endedNs / 1_000_000,
    totalMs: Math.round((endedNs - startedNs) / 1_000_000),
  };
}

function loadCursorTargetTurn(path: string): JsonObject[] {
  const size = statSync(path).size;
  let limit = Math.min(size, CURSOR_INITIAL_TAIL);
  while (true) {
    const { records, atStart } = readJsonlTail(path, limit);
    const allEndIndexes = records
      .map((record, index) => ({ record, index }))
      .filter(({ record }) => record.type === "turn_ended")
      .map(({ index }) => index);
    const successfulEndIndexes = allEndIndexes.filter((index) =>
      ["success", "completed"].includes(String(records[index]?.status ?? "success").toLowerCase())
    );
    if (successfulEndIndexes.length) {
      const targetEnd = successfulEndIndexes.at(-1)!;
      const priorEnd = [...allEndIndexes].reverse().find((index) => index < targetEnd);
      if (priorEnd !== undefined || atStart) {
        return records.slice((priorEnd ?? -1) + 1, targetEnd + 1);
      }
    }
    if (atStart) throw new Error("no completed Cursor turn exists before the Hook follow-up");
    if (limit >= CURSOR_MAX_TAIL) {
      throw new Error("Cursor target turn exceeds the 16 MiB bounded tail; provide a smaller exact transcript or archive the turn evidence");
    }
    limit = Math.min(size, Math.min(CURSOR_MAX_TAIL, limit * 2));
  }
}

function readJsonlTail(path: string, limit: number): { records: JsonObject[]; atStart: boolean } {
  const size = statSync(path).size;
  const offset = Math.max(0, size - limit);
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(size - offset);
    readSync(fd, buffer, 0, buffer.length, offset);
    let text = buffer.toString("utf8");
    if (offset > 0) {
      const newline = text.indexOf("\n");
      if (newline < 0) return { records: [], atStart: false };
      text = text.slice(newline + 1);
    }
    return { records: parseJsonl(text, path), atStart: offset === 0 };
  } finally {
    closeSync(fd);
  }
}

function resolveCodexSession(conversationId: string, codexHome: string): string {
  const sessions = join(codexHome, "sessions");
  const dates = [0, 1].map((daysAgo) => {
    const date = new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
    return join(sessions, ...date.split("-"));
  });
  const matches: string[] = [];
  for (const dir of dates) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const path = join(dir, entry.name);
      if (entry.name.includes(conversationId)) matches.push(path);
    }
  }
  if (matches.length !== 1) {
    throw new Error(
      matches.length
        ? `multiple Codex rollouts match conversationId=${JSON.stringify(conversationId)}; pass --session`
        : `no Codex rollout found for conversationId=${JSON.stringify(conversationId)} in current/previous UTC date directories; pass --session`,
    );
  }
  return matches[0]!;
}

function resolveCursorSession(cursorHome: string, conversationId: string): string {
  const projects = join(cursorHome, "projects");
  if (!existsSync(projects)) throw new Error(`Cursor projects directory is unavailable: ${projects}`);
  const matches: string[] = [];
  for (const entry of readdirSync(projects, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(projects, entry.name, "agent-transcripts", conversationId, `${conversationId}.jsonl`);
    if (existsSync(path) && statSync(path).isFile()) matches.push(path);
  }
  if (!matches.length) throw new Error(`no main Cursor transcript found for conversationId=${JSON.stringify(conversationId)}`);
  if (matches.length > 1) throw new Error(`multiple main Cursor transcripts found for conversationId=${JSON.stringify(conversationId)}; use --session`);
  return matches[0]!;
}

function observedTime(record: JsonObject): ObservedTime {
  const payload = asObject(record.payload);
  const metadata = asObject(payload?.internal_chat_message_metadata_passthrough);
  const createTime = metadata?.create_time;
  if (typeof createTime === "number" && Number.isFinite(createTime) && createTime > 0) {
    const ms = createTime * 1000;
    return { ms, iso: new Date(ms).toISOString(), source: "internal_create_time" };
  }
  const timestamp = stringValue(record.timestamp);
  const ms = timestamp ? Date.parse(timestamp) : Number.NaN;
  if (!timestamp || !Number.isFinite(ms)) throw new Error("transcript record is missing a valid timestamp");
  return { ms, iso: new Date(ms).toISOString(), source: "outer_timestamp" };
}

function outerTime(record: JsonObject): ObservedTime {
  const timestamp = stringValue(record.timestamp);
  const ms = timestamp ? Date.parse(timestamp) : Number.NaN;
  if (!timestamp || !Number.isFinite(ms)) throw new Error("transcript record is missing a valid outer timestamp");
  return { ms, iso: new Date(ms).toISOString(), source: "outer_timestamp" };
}

function ensureMonotonic(start: ObservedTime, end: ObservedTime, label: string): void {
  if (end.ms < start.ms) throw new Error(`${label} has non-monotonic observed timestamps`);
}

function intervalUnionMs(intervals: Array<[number, number]>): number {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const interval of sorted) {
    const last = merged.at(-1);
    if (!last || interval[0] > last[1]) merged.push([...interval]);
    else last[1] = Math.max(last[1], interval[1]);
  }
  return Math.round(merged.reduce((sum, [start, end]) => sum + end - start, 0));
}

function isUserMessage(record: JsonObject): boolean {
  const payload = asObject(record.payload);
  return record.type === "response_item" && payload?.type === "message" && payload.role === "user";
}

function isTaskStarted(record: JsonObject, turnId: string): boolean {
  const payload = asObject(record.payload);
  return record.type === "event_msg" && payload?.type === "task_started" && payload.turn_id === turnId;
}

function validateCodexConversation(records: JsonObject[], conversationId: string): void {
  const sessionIds = records
    .filter((record) => record.type === "session_meta")
    .map((record) => stringValue(asObject(record.payload)?.id))
    .filter((value): value is string => value !== null);
  if (!sessionIds.includes(conversationId)) {
    throw new Error(`Codex rollout does not match Hook conversationId=${JSON.stringify(conversationId)}`);
  }
}

function isAssistantMessage(record: JsonObject): boolean {
  const payload = asObject(record.payload);
  return record.type === "response_item" && payload?.type === "message" && payload.role === "assistant";
}

function isAssistantFinal(record: JsonObject): boolean {
  const payload = asObject(record.payload);
  return isAssistantMessage(record) && ["final", "final_answer"].includes(String(payload?.phase ?? ""));
}

function messageText(record: JsonObject): string {
  const payload = asObject(record.payload);
  const content = Array.isArray(payload?.content) ? payload.content : [];
  return content
    .map((item) => asObject(item)?.text)
    .filter((value): value is string => typeof value === "string")
    .join("")
    .trim();
}

function cursorContent(record: JsonObject): JsonObject[] {
  const message = asObject(record.message);
  return Array.isArray(message?.content)
    ? message.content.map(asObject).filter((item): item is JsonObject => item !== null)
    : [];
}

function cursorTextItems(record: JsonObject): string[] {
  return cursorContent(record)
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => String(item.text).trim())
    .filter(Boolean);
}

function cursorUserText(turn: JsonObject[]): string {
  for (const record of turn) {
    if (record.role !== "user") continue;
    for (const text of cursorTextItems(record)) {
      const match = /<user_query>\s*([\s\S]*?)\s*<\/user_query>/.exec(text);
      return (match?.[1] ?? text).trim();
    }
  }
  return "";
}

function describeRecord(record: JsonObject): string {
  const payload = asObject(record.payload);
  if (payload?.type === "message") return `message:${String(payload.role ?? "unknown")}:${String(payload.phase ?? "default")}`;
  if (TOOL_CALL_TYPES.has(String(payload?.type ?? ""))) return `tool_call:${String(payload?.name ?? "unknown")}`;
  if (TOOL_OUTPUT_TYPES.has(String(payload?.type ?? ""))) return "tool_output";
  if (isCompaction(record)) return "context_compacted";
  return String(payload?.type ?? record.type ?? "unknown");
}

function failedOutput(value: unknown, allowSerializedEnvelope: boolean): boolean {
  if (Array.isArray(value)) {
    const texts = value
      .map((item) => asObject(item)?.text ?? item)
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim());
    if (texts.some((text) => /^(?:script failed|process exited with code [1-9]\d*)/i.test(text))) return true;
    if (texts.some((text) => /^script completed/i.test(text))) return false;
    return value.some((item) => failedOutput(item, allowSerializedEnvelope));
  }
  const object = asObject(value);
  if (object) {
    if (typeof object.isError === "boolean") return object.isError;
    if (typeof object.is_error === "boolean") return object.is_error;
    for (const key of ["exit_code", "exitCode", "returncode", "return_code"]) {
      if (typeof object[key] === "number") return object[key] !== 0;
    }
    for (const key of ["content", "result", "output", "text"]) {
      if (key in object && failedOutput(object[key], allowSerializedEnvelope)) return true;
    }
    return false;
  }
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (/^(?:script failed|process exited with code [1-9]\d*)/i.test(text)) return true;
  if (!allowSerializedEnvelope) return false;
  try {
    return failedOutput(JSON.parse(text), false);
  } catch {
    return false;
  }
}

function usesSerializedExecutionEnvelope(toolName: string): boolean {
  return /(?:^|\.)(?:exec|exec_command|write_stdin|shell)$/i.test(toolName);
}

function normalizeInput(value: unknown): JsonObject {
  if (asObject(value)) return asObject(value)!;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (asObject(parsed)) return asObject(parsed)!;
    } catch {
      return { value };
    }
  }
  return { value };
}

function redactPreview(value: unknown, limit: number): string {
  const structured = redactStructured(value);
  let text = typeof structured === "string" ? structured : stableString(structured);
  text = text
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^:\s'\"]+):([^@\s'\"]+)@/gi, "$1:<redacted>@")
    .replace(/((?:Authorization|X-API-Key|API-Key)\s*:\s*)(?:(?:Bearer|Basic|Token|ApiKey)\s+)?(?:\[[^\]]*\]|\{[^}]*\}|"[^"]*"|'[^']*'|[^\s,;}]+)/gi, "$1<redacted>")
    .replace(/((?:--)?[A-Za-z0-9_-]*(?:token|password|passwd|secret|authorization|api[-_]?key)[A-Za-z0-9_-]*(?:=|\s+))(?:(?:"[^"]*")|(?:'[^']*')|[^\s,;}]+)/gi, "$1<redacted>")
    .replace(/\b((?=[A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|AUTHORIZATION|API_?KEY))[A-Z_][A-Z0-9_]*\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, "$1<redacted>")
    .replace(/(["'][^"']*(?:token|password|passwd|secret|authorization|api[-_]?key)[^"']*["']\s*:\s*)(?:"[^"]*"|'[^']*'|\[[^\]]*\]|\{[^}]*\}|[^,\s}\]]+)/gi, '$1"<redacted>"');
  text = normalizeWhitespace(text);
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function redactStructured(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactStructured);
  const object = asObject(value);
  if (!object) return value;
  return Object.fromEntries(
    Object.entries(object).map(([key, item]) => [key, SENSITIVE_KEY_RE.test(key) ? "<redacted>" : redactStructured(item)]),
  );
}

function bounded<T>(items: T[], top: number): BoundedList<T> {
  const selected = items.slice(0, top);
  return { total: items.length, returned: selected.length, truncated: items.length > selected.length, items: selected };
}

function boundSubagentEvidence(
  evidence: SubagentEfficiencyEvidence,
  top: number,
): BoundedSubagentEfficiencyEvidence {
  const subagents = evidence.subagents.map((subagent) => ({
    ...subagent,
    activations: bounded(subagent.activations, top),
  }));
  return {
    ...evidence,
    subagents: bounded(subagents, top),
  };
}

function isCompaction(record: JsonObject): boolean {
  const payload = asObject(record.payload);
  return [record.type, payload?.type].some((value) => typeof value === "string" && /compact/i.test(value));
}

function readJsonObject(path: string, expectedSchema: string): JsonObject {
  const value = JSON.parse(readFileSync(path, "utf8"));
  const object = asObject(value);
  if (!object || object.schema !== expectedSchema) throw new Error(`invalid ${expectedSchema} record: ${path}`);
  return object;
}

function readJsonl(path: string): JsonObject[] {
  return parseJsonl(readFileSync(path, "utf8"), path);
}

function parseJsonl(text: string, path: string): JsonObject[] {
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        const parsed = JSON.parse(line);
        const object = asObject(parsed);
        if (!object) throw new Error("row is not an object");
        return object;
      } catch (error) {
        throw new Error(`invalid JSONL at ${path}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
}

function requireFile(path: string, label: string): string {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${label} not found: ${path}`);
  return path;
}

function positiveNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`Cursor Hook state has invalid ${field}`);
  return value;
}

function wallNsIso(value: number): string {
  const date = new Date(value / 1_000_000);
  if (!Number.isFinite(date.getTime())) throw new Error("Cursor Hook state has out-of-range wall clock");
  return date.toISOString();
}

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function stableString(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
