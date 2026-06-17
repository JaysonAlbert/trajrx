import { enrichCodexSession } from "../../enrich/codexToolMetrics.js";
import { flattenCodexToMarkdown } from "../../export/codexFlatten.js";
import { codexIr } from "../codexIr.js";
import { parseCodexRollout } from "../codexParser.js";
import type { RawTrajectory } from "../../types/index.js";
import type { CodexRolloutEvent } from "../../types/codex.js";
import type { CodexSessionToolStats } from "../../enrich/codexToolMetrics.js";
import type { FlattenOptions, TranscriptAdapter, TranscriptEnrichment } from "./types.js";

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `~${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `~${Math.round(n / 1_000)}K`;
  return `~${n.toLocaleString()}`;
}

export const codexAdapter: TranscriptAdapter = {
  format: "codex_rollout",

  enrich(_inputPath, raw) {
    const traj = raw[0]!;
    const session = parseCodexRollout(traj.events as CodexRolloutEvent[], traj.trajectory_id);
    const { metricsMap, sessionToolStats } = enrichCodexSession(session);
    const toolTimeSec = Math.round(sessionToolStats.total_duration_ms / 1000);
    const outputTokens = sessionToolStats.total_output_tokens;
    return {
      format: "codex_rollout",
      metricsMap,
      sessionToolStats: sessionToolStats as unknown as Record<string, unknown>,
      codexSession: session,
      events: traj.events.length,
      toolTimeSec,
      outputTokens,
      detail: `codex · ${traj.events.length} events · ${toolTimeSec}s · ${formatTokenCount(outputTokens)} tokens`,
    };
  },

  flatten(raw, enrichment, opts) {
    const traj = raw[0]!;
    return flattenCodexToMarkdown(traj.events as CodexRolloutEvent[], {
      trajectoryId: opts.trajectoryId,
      sourcePath: opts.sourcePath,
      toolMetrics: enrichment.metricsMap,
      sessionToolStats: enrichment.sessionToolStats as unknown as CodexSessionToolStats,
    });
  },

  buildIr(raw, enrichment) {
    const traj = raw[0]!;
    return codexIr(
      traj.events as CodexRolloutEvent[],
      traj.trajectory_id,
      enrichment.metricsMap,
      enrichment.sessionToolStats,
    );
  },
};
