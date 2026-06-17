import { aggregateSessionToolStats, buildEnrichmentContext, enrichAllToolCalls } from "../../enrich/toolMetrics.js";
import { flattenEventsToMarkdown } from "../../export/flatten.js";
import { cursorIr } from "../cursorIr.js";
import type { RawTrajectory } from "../../types/index.js";
import type { CursorEvent } from "../../types/index.js";
import type { FlattenOptions, TranscriptAdapter, TranscriptEnrichment } from "./types.js";

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `~${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `~${Math.round(n / 1_000)}K`;
  return `~${n.toLocaleString()}`;
}

export const cursorAdapter: TranscriptAdapter = {
  format: "cursor",

  enrich(inputPath, raw) {
    const traj = raw[0]!;
    const ctx = buildEnrichmentContext(inputPath);
    const metricsMap = enrichAllToolCalls(traj.events as CursorEvent[], ctx);
    const sessionToolStats = aggregateSessionToolStats(traj.events as CursorEvent[], metricsMap);
    const toolTimeSec = Math.round(sessionToolStats.total_duration_ms / 1000);
    const outputTokens = sessionToolStats.total_output_tokens;
    return {
      format: "cursor",
      metricsMap,
      sessionToolStats: sessionToolStats as unknown as Record<string, unknown>,
      cursorContext: ctx,
      events: traj.events.length,
      toolTimeSec,
      outputTokens,
      detail: `cursor · ${traj.events.length} events · ${toolTimeSec}s · ${formatTokenCount(outputTokens)} tokens`,
    };
  },

  flatten(raw, enrichment, opts) {
    const traj = raw[0]!;
    return flattenEventsToMarkdown(traj.events as CursorEvent[], {
      trajectoryId: opts.trajectoryId,
      sourcePath: opts.sourcePath,
      toolMetrics: enrichment.metricsMap,
      sessionToolStats: enrichment.sessionToolStats,
    });
  },

  buildIr(raw, enrichment) {
    return cursorIr(raw, enrichment.metricsMap, enrichment.sessionToolStats, {
      terminals: enrichment.cursorContext?.terminals ?? [],
    });
  },
};
