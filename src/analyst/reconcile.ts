import type { TrajectoryIR } from "../types/index.js";

function phaseForTurn(turn: number): string {
  if (turn <= 5) return "P1_setup_and_structure";
  if (turn <= 14) return "P2_db_env_debug";
  if (turn <= 18) return "P3_data_fix_seed";
  return "P4_history_gen_wrapup";
}

export function manualAttribution(traj: TrajectoryIR) {
  const steps = traj.steps ?? [];
  const userTurns = traj.metadata.user_turns ?? 0;
  const stepCount = steps.length;

  const totalReads = steps.reduce((n, s) => n + s.telemetry.read_count, 0);
  const totalMcps = steps.reduce((n, s) => n + s.telemetry.mcp_count, 0);
  const totalShells = steps.reduce((n, s) => n + s.telemetry.shell_count, 0);
  let harnessRuns = 0;
  for (const s of steps) {
    for (const cmd of s.telemetry.shell_cmds) {
      if (cmd.includes("harness test run")) harnessRuns++;
    }
  }

  const causes: Record<string, number> = {};
  const findings: string[] = [];

  if (userTurns >= 20) {
    causes.context = (causes.context ?? 0) + 3;
    findings.push(`Scope creep: ${userTurns} user turns with evolving requirements`);
  }
  if (stepCount / Math.max(userTurns, 1) > 10) {
    causes.context = (causes.context ?? 0) + 2;
    findings.push(`Context bloat: ${stepCount} assistant steps / ${userTurns} user turns`);
  }
  if (totalReads > 80) {
    causes.context = (causes.context ?? 0) + 2;
    findings.push(`Excessive re-reads: ${totalReads} Read calls`);
  }
  if (harnessRuns >= 6) {
    causes.tool = (causes.tool ?? 0) + 4;
    findings.push(`Harness trial-and-error: ${harnessRuns} test runs without converging`);
  }
  if (totalShells > 80) {
    causes.tool = (causes.tool ?? 0) + 2;
    findings.push(`Shell-heavy debugging: ${totalShells} shell invocations`);
  }
  if (totalMcps > 100) {
    causes.mcp = (causes.mcp ?? 0) + 3;
    findings.push(`MCP thrashing: ${totalMcps} DB/log queries (oracle-heavy)`);
  }

  if (!Object.keys(causes).length) causes.none = 1;

  const ranked = Object.entries(causes).sort((a, b) => b[1] - a[1]);
  const primary = ranked[0]![0];
  const total = ranked.reduce((n, [, s]) => n + s, 0);

  return {
    trajectory_id: traj.trajectory_id,
    primary_cause: primary,
    confidence: Math.round((causes[primary]! / Math.max(total, 1)) * 100) / 100,
    category_scores: causes,
    secondary_causes: ranked.slice(1, 3).map(([c]) => c).filter((c) => c !== primary),
    findings,
    harness_test_runs: harnessRuns,
    method: "manual_heuristic_v1",
  };
}

export function reconcile(staticAttr: Record<string, unknown>, manualAttr: Record<string, unknown>) {
  const staticPrimary = staticAttr.primary_cause as string;
  const manualPrimary = manualAttr.primary_cause as string;
  const staticScores = (staticAttr.category_scores ?? {}) as Record<string, number>;
  const manualScores = (manualAttr.category_scores ?? {}) as Record<string, number>;
  const manualSecondary = (manualAttr.secondary_causes ?? []) as string[];
  const staticComposite = (staticAttr.composite_causes ?? []) as string[];

  let primaryMatch =
    staticPrimary === manualPrimary ||
    (staticPrimary === "compound" && staticComposite.includes(manualPrimary)) ||
    manualSecondary.includes(staticPrimary);

  const allCats = new Set([...Object.keys(staticScores), ...Object.keys(manualScores)]);
  const scoreDiffs: Record<string, { static: number; manual: number; delta: number }> = {};
  for (const cat of [...allCats].sort()) {
    scoreDiffs[cat] = {
      static: staticScores[cat] ?? 0,
      manual: manualScores[cat] ?? 0,
      delta: Math.round(((manualScores[cat] ?? 0) - (staticScores[cat] ?? 0)) * 10) / 10,
    };
  }

  const staticTop2 = new Set(Object.entries(staticScores).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([c]) => c));
  const manualTop2 = new Set(Object.entries(manualScores).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([c]) => c));
  const top2Overlap = [...staticTop2].filter((c) => manualTop2.has(c));

  let verdict = primaryMatch ? "consistent" : "partial";
  if (!primaryMatch && !top2Overlap.length) verdict = "divergent";

  const notes: string[] = [];
  if (primaryMatch) notes.push(`Primary cause agrees: **${staticPrimary}**`);
  else notes.push(`Primary cause differs: static=${staticPrimary} vs manual=${manualPrimary}`);
  if (staticComposite.length) notes.push(`Static composite: ${staticComposite.join(", ")}`);
  if (manualSecondary.includes(staticPrimary)) notes.push("Manual secondary includes static primary");
  if (top2Overlap.length) notes.push(`Top-2 overlap: ${top2Overlap.sort().join(", ")}`);

  return {
    trajectory_id: staticAttr.trajectory_id,
    verdict,
    primary_match: primaryMatch,
    static_primary: staticPrimary,
    manual_primary: manualPrimary,
    static_confidence: staticAttr.confidence,
    manual_confidence: manualAttr.confidence,
    score_diffs: scoreDiffs,
    top2_overlap: top2Overlap,
    notes,
    static_evidence: ((staticAttr.top_violations as { invariant_id: string; message: string }[]) ?? []).slice(0, 3).map((v) => `[${v.invariant_id}] ${v.message}`),
    manual_evidence: (manualAttr.findings as string[])?.slice(0, 3) ?? [],
  };
}
