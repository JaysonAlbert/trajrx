import { statSync } from "node:fs";
import { resolveAdapter } from "../ir/adapters/index.js";
import { loadTrajectories } from "../ir/loader.js";
import type { RawTrajectory, Substep, TrajectoryIR } from "../types/index.js";
import type { TranscriptSource } from "../config.js";

export interface CheapSessionFeatures {
  feature_version: 1;
  extraction_status: "complete" | "partial" | "unavailable";
  gross_wall_ms: number | null;
  active_wall_ms: number | null;
  turns: number | null;
  steps: number | null;
  tool_calls: number | null;
  tool_output_tokens: number | null;
  transcript_bytes: number;
  resume_count: number | null;
  compaction_count: number | null;
  subagent_count: number | null;
  error_count: number | null;
  retry_count: number | null;
  loop_signal_count: number | null;
  unavailable: string[];
}

const NULLABLE_FEATURES = [
  "gross_wall_ms",
  "active_wall_ms",
  "turns",
  "steps",
  "tool_calls",
  "tool_output_tokens",
  "resume_count",
  "compaction_count",
  "subagent_count",
  "error_count",
  "retry_count",
  "loop_signal_count",
] as const;

type NullableFeature = (typeof NULLABLE_FEATURES)[number];

export function extractCheapSessionFeatures(
  transcriptPath: string,
  expectedSource?: TranscriptSource,
): CheapSessionFeatures {
  const transcriptBytes = safeTranscriptSize(transcriptPath);
  try {
    const raw = loadTrajectories(transcriptPath);
    const first = raw[0];
    if (!first) return unavailableFeatures(transcriptBytes);
    const adapter = resolveAdapter(first);
    const enrichment = adapter.enrich(transcriptPath, raw);
    const trajectory = adapter.buildIr(raw, enrichment)[0];
    if (!trajectory) return unavailableFeatures(transcriptBytes);

    const source = expectedSource ?? (adapter.format === "codex_rollout" ? "codex" : "cursor");
    const toolSubsteps = trajectory.steps.flatMap((step) => step.substeps.filter((substep) => substep.tool_name));
    const toolOutputTokens = observedToolOutputTokens(toolSubsteps);
    const signatures = toolSubsteps.map(toolSignature).filter((value): value is string => Boolean(value));
    const signatureCounts = countValues(signatures);
    const retryCount = [...signatureCounts.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
    const loopSignalCount = [...signatureCounts.values()].filter((count) => count >= 3).length;
    const rawEvents = raw.flatMap((item) => item.events);

    const features: CheapSessionFeatures = {
      feature_version: 1,
      extraction_status: "complete",
      gross_wall_ms: finiteNumber(trajectory.metadata.session_wall_ms),
      active_wall_ms: finiteNumber(trajectory.metadata.session_active_wall_ms),
      turns: finiteNumber(trajectory.metadata.user_turns),
      steps: trajectory.steps.length,
      tool_calls: toolSubsteps.length,
      tool_output_tokens: toolOutputTokens,
      transcript_bytes: transcriptBytes,
      resume_count: source === "codex" ? codexResumeCount(raw) : null,
      compaction_count: source === "codex" ? codexCompactionCount(raw) : null,
      subagent_count: toolSubsteps.filter(isSubagentSpawn).length,
      error_count: countExplicitErrors(rawEvents, toolSubsteps),
      retry_count: retryCount,
      loop_signal_count: loopSignalCount,
      unavailable: [],
    };
    features.unavailable = unavailableFields(features);
    features.extraction_status = features.unavailable.length ? "partial" : "complete";
    return features;
  } catch {
    return unavailableFeatures(transcriptBytes);
  }
}

function unavailableFeatures(transcriptBytes: number): CheapSessionFeatures {
  return {
    feature_version: 1,
    extraction_status: "unavailable",
    gross_wall_ms: null,
    active_wall_ms: null,
    turns: null,
    steps: null,
    tool_calls: null,
    tool_output_tokens: null,
    transcript_bytes: transcriptBytes,
    resume_count: null,
    compaction_count: null,
    subagent_count: null,
    error_count: null,
    retry_count: null,
    loop_signal_count: null,
    unavailable: [...NULLABLE_FEATURES],
  };
}

function unavailableFields(features: CheapSessionFeatures): string[] {
  return NULLABLE_FEATURES.filter((field) => features[field] === null);
}

function safeTranscriptSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function observedToolOutputTokens(substeps: Substep[]): number | null {
  if (!substeps.length) return 0;
  const executions = substeps.map((substep) => substep.execution);
  if (executions.some((execution) => !execution || execution.output_source === "unknown")) return null;
  return executions.reduce((total, execution) => total + (execution?.output_tokens ?? 0), 0);
}

function toolSignature(substep: Substep): string | null {
  if (!substep.tool_name) return null;
  const input = stripInternalFields(substep.tool_input ?? {});
  return `${substep.tool_name}:${stableJson(input)}`;
}

function stripInternalFields(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith("_")));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

function countValues(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function isSubagentSpawn(substep: Substep): boolean {
  const name = substep.tool_name?.toLowerCase() ?? "";
  return name === "task" || name === "spawn_agent" || name.endsWith("__spawn_agent");
}

function codexResumeCount(raw: RawTrajectory[]): number {
  const sessionMeta = raw
    .flatMap((trajectory) => trajectory.events)
    .filter((event) => event && typeof event === "object" && (event as { type?: string }).type === "session_meta")
    .map((event) => event as { payload?: { id?: unknown } });
  const sessionId = sessionMeta[0]?.payload?.id;
  if (typeof sessionId !== "string" || !sessionId) return 0;
  const matchingMetadata = sessionMeta.filter((event) => event.payload?.id === sessionId).length;
  return Math.max(0, matchingMetadata - 1);
}

function codexCompactionCount(raw: RawTrajectory[]): number {
  return raw
    .flatMap((trajectory) => trajectory.events)
    .filter((event) => {
      if (!event || typeof event !== "object") return false;
      const row = event as { type?: unknown; payload?: { type?: unknown } };
      return [row.type, row.payload?.type].some((value) => typeof value === "string" && /compact/i.test(value));
    })
    .length;
}

function countExplicitErrors(events: unknown[], substeps: Substep[]): number {
  const eventErrors = events.filter(hasExplicitErrorSignal).length;
  const toolErrors = substeps.filter((substep) => {
    const preview = substep.tool_input?._codex_output_preview;
    return typeof preview === "string" && /(?:exit(?:ed)? (?:code|status)[: ]+[1-9]\d*|timed? out|connection refused|traceback|\berror:)/i.test(preview);
  }).length;
  return eventErrors + toolErrors;
}

function hasExplicitErrorSignal(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  if (row.isError === true || row.is_error === true) return true;
  if (typeof row.type === "string" && /(?:^|_)error$/i.test(row.type)) return true;
  if (typeof row.exit_code === "number" && row.exit_code !== 0) return true;
  if (typeof row.returncode === "number" && row.returncode !== 0) return true;
  const payload = row.payload;
  if (payload && typeof payload === "object") return hasExplicitErrorSignal(payload);
  return false;
}
