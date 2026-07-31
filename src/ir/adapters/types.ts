import type { RawTrajectory, ToolExecutionMetrics, TrajectoryIR } from "../../types/index.js";
import type { ParsedCodexSession } from "../../types/codex.js";
import type { EnrichmentContext } from "../../enrich/toolMetrics.js";

export type TranscriptFormat = "cursor" | "codex_rollout";

export interface TranscriptEnrichment {
  format: TranscriptFormat;
  metricsMap: Map<string, ToolExecutionMetrics>;
  sessionToolStats: Record<string, unknown>;
  events: number;
  toolTimeSec: number;
  outputTokens: number;
  detail: string;
  /** Codex parsed session — only for codex_rollout. */
  codexSession?: ParsedCodexSession;
  /** Cursor enrichment context — only for cursor. */
  cursorContext?: EnrichmentContext;
}

export interface FlattenOptions {
  trajectoryId: string;
  sourcePath: string;
}

export interface TranscriptAdapter {
  readonly format: TranscriptFormat;
  enrich(inputPath: string, raw: RawTrajectory[]): TranscriptEnrichment;
  flatten(raw: RawTrajectory[], enrichment: TranscriptEnrichment, opts: FlattenOptions): string;
  buildIr(raw: RawTrajectory[], enrichment: TranscriptEnrichment): TrajectoryIR[];
}
