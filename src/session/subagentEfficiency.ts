import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import type { TranscriptSource } from "../config.js";
import type { CodexRolloutEvent } from "../types/codex.js";

export type SubagentTimingSource = "task_events" | "file_times";

export interface SubagentActivation {
  activation_id: string;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  status: "complete" | "aborted" | "incomplete";
}

export interface SubagentSessionEvidence {
  session_id: string;
  parent_session_id: string;
  task_name: string | null;
  nickname: string | null;
  depth: number;
  timing_source: SubagentTimingSource;
  started_at: string | null;
  ended_at: string | null;
  execution_ms: number;
  activation_count: number;
  status: "complete" | "aborted" | "incomplete";
  transcript_path: string;
  activations: SubagentActivation[];
}

export interface SubagentEfficiencyEvidence {
  schema_version: 1;
  source: TranscriptSource;
  timing_precision: "event_timestamps" | "file_times";
  scope: { started_at: string; ended_at: string } | null;
  subagent_count: number;
  activation_count: number;
  aborted_count: number;
  execution_sum_ms: number;
  wall_union_ms: number;
  parent_wait_ms: number | null;
  parent_wait_count: number | null;
  max_parallelism: number;
  subagents: SubagentSessionEvidence[];
  unavailable: string[];
}

export interface SubagentEfficiencyOptions {
  startedAt?: string;
  endedAt?: string;
}

interface Interval {
  start: number;
  end: number;
}

interface CodexSessionMeta {
  id: string;
  parentId: string | null;
  taskName: string | null;
  nickname: string | null;
  depth: number;
  path: string;
}

export function extractSubagentEfficiency(
  transcriptPath: string,
  expectedSource?: TranscriptSource,
  options: SubagentEfficiencyOptions = {},
): SubagentEfficiencyEvidence {
  const source = expectedSource ?? inferSource(transcriptPath);
  const evidence = source === "cursor"
    ? extractCursorSubagentEfficiency(transcriptPath)
    : extractCodexSubagentEfficiency(transcriptPath);
  return applyScope(evidence, options, transcriptPath);
}

function inferSource(path: string): TranscriptSource {
  return path.includes(`${sep}agent-transcripts${sep}`) ? "cursor" : "codex";
}

function emptyEvidence(source: TranscriptSource): SubagentEfficiencyEvidence {
  return {
    schema_version: 1,
    source,
    timing_precision: source === "codex" ? "event_timestamps" : "file_times",
    scope: null,
    subagent_count: 0,
    activation_count: 0,
    aborted_count: 0,
    execution_sum_ms: 0,
    wall_union_ms: 0,
    parent_wait_ms: source === "codex" ? 0 : null,
    parent_wait_count: source === "codex" ? 0 : null,
    max_parallelism: 0,
    subagents: [],
    unavailable: source === "codex" ? [] : ["parent_wait_ms", "parent_wait_count"],
  };
}

function extractCodexSubagentEfficiency(transcriptPath: string): SubagentEfficiencyEvidence {
  const base = emptyEvidence("codex");
  const parentEvents = readCodexEvents(transcriptPath);
  if (!parentEvents.length) {
    return {
      ...base,
      parent_wait_ms: null,
      parent_wait_count: null,
      unavailable: ["parent_session_metadata", "parent_wait_ms", "parent_wait_count"],
    };
  }
  const parentId = rootSessionId(parentEvents);
  if (!parentId) {
    return {
      ...base,
      parent_wait_ms: null,
      parent_wait_count: null,
      unavailable: ["parent_session_metadata", "parent_wait_ms", "parent_wait_count"],
    };
  }

  const metadata = candidateCodexFiles(transcriptPath, parentEvents)
    .filter((path) => path !== transcriptPath)
    .map(readCodexSessionMeta)
    .filter((item): item is CodexSessionMeta => item !== null);
  const descendants = collectDescendants(metadata, parentId);
  const subagents = descendants
    .map((meta) => codexSubagentEvidence(meta))
    .sort(compareSubagents);
  const intervals = completeIntervals(subagents);
  const incomplete = subagents.some((child) => child.status === "incomplete");
  const parentWaitIntervals = codexParentWaitIntervals(parentEvents);

  return {
    ...base,
    subagent_count: subagents.length,
    activation_count: subagents.reduce((total, child) => total + child.activation_count, 0),
    aborted_count: subagents.reduce(
      (total, child) => total + child.activations.filter((activation) => activation.status === "aborted").length,
      0,
    ),
    execution_sum_ms: subagents.reduce((total, child) => total + child.execution_ms, 0),
    wall_union_ms: intervalUnionMs(intervals),
    parent_wait_ms: intervalUnionMs(parentWaitIntervals),
    parent_wait_count: parentWaitIntervals.length,
    max_parallelism: maxParallelism(intervals),
    subagents,
    unavailable: incomplete ? ["incomplete_activation_duration"] : [],
  };
}

function readCodexEvents(path: string): CodexRolloutEvent[] {
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as CodexRolloutEvent);
  } catch {
    return [];
  }
}

function rootSessionId(events: CodexRolloutEvent[]): string | null {
  for (const event of events) {
    if (event.type !== "session_meta") continue;
    const id = event.payload?.id;
    if (typeof id === "string" && id) return id;
  }
  return null;
}

function candidateCodexFiles(transcriptPath: string, events: CodexRolloutEvent[]): string[] {
  const marker = `${sep}sessions${sep}`;
  const markerIndex = transcriptPath.indexOf(marker);
  if (markerIndex < 0) return siblingJsonlFiles(dirname(transcriptPath));
  const sessionsRoot = transcriptPath.slice(0, markerIndex + marker.length - 1);
  const dates = eventDateKeys(events);
  const paths = new Set<string>();
  for (const date of dates) {
    const dayDir = join(sessionsRoot, ...date.split("-"));
    for (const path of siblingJsonlFiles(dayDir)) paths.add(path);
  }
  // Synthetic fixtures and older layouts may not use date directories.
  for (const path of siblingJsonlFiles(dirname(transcriptPath))) paths.add(path);
  return [...paths];
}

function eventDateKeys(events: CodexRolloutEvent[]): Set<string> {
  const times = events
    .map((event) => Date.parse(event.timestamp))
    .filter((value) => Number.isFinite(value));
  if (!times.length) return new Set();
  const start = Math.min(...times) - 86_400_000;
  const end = Math.max(...times) + 86_400_000;
  const dates = new Set<string>();
  for (let time = start; time <= end; time += 86_400_000) {
    dates.add(new Date(time).toISOString().slice(0, 10));
  }
  return dates;
}

function siblingJsonlFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }
}

function readCodexSessionMeta(path: string): CodexSessionMeta | null {
  const events = readCodexEvents(path);
  const event = events.find((item) => item.type === "session_meta");
  if (!event?.payload) return null;
  const payload = event.payload;
  const spawn = nestedRecord(nestedRecord(nestedRecord(payload.source, "subagent"), "thread_spawn"));
  const id = stringValue(payload.id);
  const parentId = stringValue(payload.parent_thread_id) ?? stringValue(spawn.parent_thread_id);
  if (!id || !parentId) return null;
  return {
    id,
    parentId,
    taskName: stringValue(payload.agent_path) ?? stringValue(spawn.agent_path),
    nickname: stringValue(payload.agent_nickname) ?? stringValue(spawn.agent_nickname),
    depth: numberValue(spawn.depth) ?? 1,
    path,
  };
}

function nestedRecord(value: unknown, key?: string): Record<string, unknown> {
  const selected = key && value && typeof value === "object" ? (value as Record<string, unknown>)[key] : value;
  return selected && typeof selected === "object" ? selected as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function collectDescendants(metadata: CodexSessionMeta[], rootId: string): CodexSessionMeta[] {
  const result: CodexSessionMeta[] = [];
  const seen = new Set<string>();
  let parents = new Set([rootId]);
  while (parents.size) {
    const next = new Set<string>();
    for (const meta of metadata) {
      if (seen.has(meta.id) || !meta.parentId || !parents.has(meta.parentId)) continue;
      seen.add(meta.id);
      result.push(meta);
      next.add(meta.id);
    }
    parents = next;
  }
  return result;
}

function codexSubagentEvidence(meta: CodexSessionMeta): SubagentSessionEvidence {
  const events = readCodexEvents(meta.path);
  const activations = codexActivations(events);
  const known = activations.filter((activation) => activation.duration_ms !== null);
  return {
    session_id: meta.id,
    parent_session_id: meta.parentId ?? "",
    task_name: meta.taskName,
    nickname: meta.nickname,
    depth: meta.depth,
    timing_source: "task_events",
    started_at: minIso(activations.map((activation) => activation.started_at)),
    ended_at: maxIso(activations.map((activation) => activation.ended_at)),
    execution_ms: known.reduce((total, activation) => total + (activation.duration_ms ?? 0), 0),
    activation_count: activations.length,
    status: activationStatus(activations),
    transcript_path: meta.path,
    activations,
  };
}

function codexActivations(events: CodexRolloutEvent[]): SubagentActivation[] {
  const started = new Map<string, string>();
  const activations: SubagentActivation[] = [];
  let sequence = 0;
  for (const event of events) {
    const type = event.payload?.type;
    if (type !== "task_started" && type !== "task_complete" && type !== "turn_aborted") continue;
    const turnId = stringValue(event.payload?.turn_id) ?? `activation-${++sequence}`;
    if (type === "task_started") {
      started.set(turnId, event.timestamp);
      continue;
    }
    const endedAt = validIso(event.timestamp);
    const observedDuration = numberValue(event.payload?.duration_ms);
    const inferredStart = endedAt && observedDuration !== null
      ? new Date(Date.parse(endedAt) - observedDuration).toISOString()
      : null;
    const startedAt = validIso(started.get(turnId)) ?? inferredStart;
    const duration = observedDuration ?? intervalDuration(startedAt, endedAt);
    activations.push({
      activation_id: turnId,
      started_at: startedAt,
      ended_at: endedAt,
      duration_ms: duration,
      status: duration !== null && startedAt !== null && endedAt !== null
        ? type === "turn_aborted" ? "aborted" : "complete"
        : "incomplete",
    });
    started.delete(turnId);
  }
  for (const [turnId, startedAt] of started) {
    activations.push({
      activation_id: turnId,
      started_at: validIso(startedAt),
      ended_at: null,
      duration_ms: null,
      status: "incomplete",
    });
  }
  return activations.sort((left, right) => (left.started_at ?? "").localeCompare(right.started_at ?? ""));
}

function codexParentWaitIntervals(events: CodexRolloutEvent[]): Interval[] {
  const calls = new Map<string, number>();
  const intervals: Interval[] = [];
  for (const event of events) {
    const payload = event.payload ?? {};
    const type = payload.type;
    const callId = stringValue(payload.call_id);
    if (!callId) continue;
    if (type === "function_call" && String(payload.name ?? "").toLowerCase().endsWith("wait_agent")) {
      const start = Date.parse(event.timestamp);
      if (Number.isFinite(start)) calls.set(callId, start);
    } else if (type === "function_call_output") {
      const start = calls.get(callId);
      const end = Date.parse(event.timestamp);
      if (start !== undefined && Number.isFinite(end) && end >= start) intervals.push({ start, end });
    }
  }
  return intervals;
}

function extractCursorSubagentEfficiency(transcriptPath: string): SubagentEfficiencyEvidence {
  const base = emptyEvidence("cursor");
  const childDir = join(dirname(transcriptPath), "subagents");
  if (!existsSync(childDir)) return base;
  const subagents = siblingJsonlFiles(childDir).map(cursorSubagentEvidence).sort(compareSubagents);
  const intervals = completeIntervals(subagents);
  return {
    ...base,
    subagent_count: subagents.length,
    activation_count: subagents.length,
    execution_sum_ms: subagents.reduce((total, child) => total + child.execution_ms, 0),
    wall_union_ms: intervalUnionMs(intervals),
    max_parallelism: maxParallelism(intervals),
    subagents,
  };
}

function cursorSubagentEvidence(path: string): SubagentSessionEvidence {
  const stat = statSync(path);
  const start = Math.round(stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.ctimeMs);
  const end = Math.max(start, Math.round(stat.mtimeMs));
  const duration = end - start;
  const id = basename(path, ".jsonl");
  const activation: SubagentActivation = {
    activation_id: id,
    started_at: new Date(start).toISOString(),
    ended_at: new Date(end).toISOString(),
    duration_ms: duration,
    status: "complete",
  };
  return {
    session_id: id,
    parent_session_id: basename(dirname(dirname(path))),
    task_name: null,
    nickname: null,
    depth: 1,
    timing_source: "file_times",
    started_at: activation.started_at,
    ended_at: activation.ended_at,
    execution_ms: duration,
    activation_count: 1,
    status: "complete",
    transcript_path: path,
    activations: [activation],
  };
}

function completeIntervals(subagents: SubagentSessionEvidence[]): Interval[] {
  return subagents.flatMap((child) => child.activations.flatMap((activation) => {
    const start = activation.started_at ? Date.parse(activation.started_at) : Number.NaN;
    const end = activation.ended_at ? Date.parse(activation.ended_at) : Number.NaN;
    return Number.isFinite(start) && Number.isFinite(end) && end >= start ? [{ start, end }] : [];
  }));
}

export function intervalUnionMs(intervals: Interval[]): number {
  const sorted = intervals
    .filter((interval) => interval.end >= interval.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  if (!sorted.length) return 0;
  let total = 0;
  let start = sorted[0]!.start;
  let end = sorted[0]!.end;
  for (const interval of sorted.slice(1)) {
    if (interval.start <= end) {
      end = Math.max(end, interval.end);
    } else {
      total += end - start;
      start = interval.start;
      end = interval.end;
    }
  }
  return Math.round(total + end - start);
}

export function maxParallelism(intervals: Interval[]): number {
  const points = intervals.flatMap((interval) => [
    { time: interval.start, delta: 1 },
    { time: interval.end, delta: -1 },
  ]).sort((left, right) => left.time - right.time || left.delta - right.delta);
  let active = 0;
  let maximum = 0;
  for (const point of points) {
    active += point.delta;
    maximum = Math.max(maximum, active);
  }
  return maximum;
}

function compareSubagents(left: SubagentSessionEvidence, right: SubagentSessionEvidence): number {
  return (left.started_at ?? "").localeCompare(right.started_at ?? "")
    || (left.task_name ?? left.session_id).localeCompare(right.task_name ?? right.session_id);
}

function validIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function intervalDuration(startedAt: string | null, endedAt: string | null): number | null {
  if (!startedAt || !endedAt) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? Math.round(end - start) : null;
}

function minIso(values: Array<string | null>): string | null {
  const valid = values.filter((value): value is string => value !== null).sort();
  return valid[0] ?? null;
}

function maxIso(values: Array<string | null>): string | null {
  const valid = values.filter((value): value is string => value !== null).sort();
  return valid.at(-1) ?? null;
}

function applyScope(
  evidence: SubagentEfficiencyEvidence,
  options: SubagentEfficiencyOptions,
  transcriptPath: string,
): SubagentEfficiencyEvidence {
  if (!options.startedAt && !options.endedAt) return evidence;
  const start = options.startedAt ? Date.parse(options.startedAt) : Number.NaN;
  const end = options.endedAt ? Date.parse(options.endedAt) : Number.NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    throw new Error("Subagent efficiency scope requires valid startedAt and endedAt timestamps");
  }

  const subagents = evidence.subagents.flatMap((child) => {
    const activations = child.activations
      .map((activation) => clipActivation(activation, start, end))
      .filter((activation): activation is SubagentActivation => activation !== null);
    if (!activations.length) return [];
    const known = activations.filter((activation) => activation.duration_ms !== null);
    return [{
      ...child,
      started_at: minIso(activations.map((activation) => activation.started_at)),
      ended_at: maxIso(activations.map((activation) => activation.ended_at)),
      execution_ms: known.reduce((total, activation) => total + (activation.duration_ms ?? 0), 0),
      activation_count: activations.length,
      status: activationStatus(activations),
      activations,
    }];
  });
  const intervals = completeIntervals(subagents);
  const scopedWaitIntervals = evidence.source === "codex"
    ? codexParentWaitIntervals(readCodexEvents(transcriptPath)).flatMap((interval) => {
      const clipped = clipInterval(interval, start, end);
      return clipped ? [clipped] : [];
    })
    : null;
  const unavailable = new Set(evidence.unavailable);
  if (!subagents.some((child) => child.status === "incomplete")) {
    unavailable.delete("incomplete_activation_duration");
  }
  return {
    ...evidence,
    scope: {
      started_at: new Date(start).toISOString(),
      ended_at: new Date(end).toISOString(),
    },
    subagent_count: subagents.length,
    activation_count: subagents.reduce((total, child) => total + child.activation_count, 0),
    aborted_count: subagents.reduce(
      (total, child) => total + child.activations.filter((activation) => activation.status === "aborted").length,
      0,
    ),
    execution_sum_ms: subagents.reduce((total, child) => total + child.execution_ms, 0),
    wall_union_ms: intervalUnionMs(intervals),
    parent_wait_ms: scopedWaitIntervals === null ? null : intervalUnionMs(scopedWaitIntervals),
    parent_wait_count: scopedWaitIntervals?.length ?? null,
    max_parallelism: maxParallelism(intervals),
    subagents,
    unavailable: [...unavailable],
  };
}

function clipActivation(activation: SubagentActivation, scopeStart: number, scopeEnd: number): SubagentActivation | null {
  const activationStart = activation.started_at ? Date.parse(activation.started_at) : Number.NaN;
  if (!Number.isFinite(activationStart)) return null;
  if (!activation.ended_at || activation.duration_ms === null) {
    if (activationStart > scopeEnd) return null;
    return activationStart >= scopeStart ? activation : { ...activation, started_at: new Date(scopeStart).toISOString() };
  }
  const activationEnd = Date.parse(activation.ended_at);
  if (!Number.isFinite(activationEnd) || activationEnd < scopeStart || activationStart > scopeEnd) return null;
  const clippedStart = Math.max(activationStart, scopeStart);
  const clippedEnd = Math.min(activationEnd, scopeEnd);
  const fullyContained = clippedStart === activationStart && clippedEnd === activationEnd;
  return {
    ...activation,
    started_at: new Date(clippedStart).toISOString(),
    ended_at: new Date(clippedEnd).toISOString(),
    duration_ms: fullyContained ? activation.duration_ms : Math.round(clippedEnd - clippedStart),
  };
}

function clipInterval(interval: Interval, scopeStart: number, scopeEnd: number): Interval | null {
  if (interval.end < scopeStart || interval.start > scopeEnd) return null;
  return { start: Math.max(interval.start, scopeStart), end: Math.min(interval.end, scopeEnd) };
}

function activationStatus(activations: SubagentActivation[]): SubagentSessionEvidence["status"] {
  if (!activations.length || activations.some((activation) => activation.status === "incomplete")) return "incomplete";
  return activations.some((activation) => activation.status === "aborted") ? "aborted" : "complete";
}
