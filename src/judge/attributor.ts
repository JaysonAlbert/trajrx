import type { Attribution, CheckerResult, Severity, TrajectoryIR, Violation } from "../types/index.js";

const SEVERITY_WEIGHT: Record<Severity, number> = { low: 1, medium: 2, high: 3, critical: 4 };

const ACTIONS: Record<string, string[]> = {
  context: [
    "Reduce parallel tool calls per turn; batch reads",
    "Summarize intermediate findings before next exploration wave",
    "Use subagent/Task for isolated exploration to avoid context bloat",
  ],
  tool: [
    "Cache grep/read results; avoid repeating identical shell commands",
    "Fix root cause before re-running harness/e2e (check logs once, fix config)",
    "Narrow search scope with known file paths from docs",
  ],
  mcp: [
    "Batch log queries; define SPL/query template upfront",
    "Verify MCP auth/connectivity before long debug loops",
    "Prefer code grep over repeated log MCP when source is local",
  ],
  skill: [
    "Read relevant SKILL.md first and follow its workflow checklist",
    "If skill was read, enforce its steps before exploratory tooling",
  ],
};

export function attribute(checkerResult: CheckerResult, _traj: TrajectoryIR): Attribution {
  const violations = checkerResult.violations ?? [];
  if (!violations.length) {
    return {
      trajectory_id: checkerResult.trajectory_id,
      primary_cause: "none",
      confidence: 1,
      critical_step: null,
      category_scores: {},
      violations_by_category: {},
      top_violations: [],
      explanation: "No preset invariant violations detected.",
      recommended_actions: [],
      telemetry_summary: checkerResult.telemetry_summary,
    };
  }

  const categoryScores: Record<string, number> = {};
  const byCat: Record<string, Violation[]> = {};
  for (const v of violations) {
    const w = SEVERITY_WEIGHT[v.severity] ?? 1;
    categoryScores[v.category] = (categoryScores[v.category] ?? 0) + w;
    (byCat[v.category] ??= []).push(v);
  }

  const ranked = Object.entries(categoryScores).sort((a, b) => b[1] - a[1]);
  let primary = ranked[0]![0];
  const totalScore = ranked.reduce((n, [, s]) => n + s, 0);
  let compositeCauses: string[] = [];

  if (ranked.length >= 2 && totalScore > 0) {
    const [, secondScore] = ranked[1]!;
    if (secondScore / totalScore >= 0.25) {
      compositeCauses = [ranked[0]![0], ranked[1]![0]];
      if (ranked[0]![1] - secondScore <= totalScore * 0.15) primary = "compound";
    }
  }

  const focusCat = primary === "compound" ? ranked[0]![0] : primary;
  const primaryViolations = [...(byCat[focusCat] ?? [])].sort((a, b) => {
    const sa = a.severity === "high" || a.severity === "critical" ? 0 : 1;
    const sb = b.severity === "high" || b.severity === "critical" ? 0 : 1;
    return sa - sb || a.step_index - b.step_index;
  });

  const topViolations = [...violations].sort((a, b) => (SEVERITY_WEIGHT[b.severity] ?? 0) - (SEVERITY_WEIGHT[a.severity] ?? 0)).slice(0, 5);

  const explanationParts: string[] = [];
  if (primary === "compound") {
    explanationParts.push(
      `Compound cause: ${compositeCauses[0]} + ${compositeCauses[1]} (scores ${categoryScores[compositeCauses[0]!]}/${categoryScores[compositeCauses[1]!]}/${totalScore})`
    );
  } else {
    explanationParts.push(`Primary cause: ${primary} (score ${categoryScores[primary]}/${totalScore})`);
  }
  for (const v of topViolations.slice(0, 3)) {
    explanationParts.push(`- [${v.invariant_id}] step ${v.step_index}: ${v.message}`);
  }

  const actionCats = primary === "compound" ? compositeCauses : [primary];
  const actions: string[] = [];
  for (const cat of actionCats) actions.push(...(ACTIONS[cat] ?? []));

  return {
    trajectory_id: checkerResult.trajectory_id,
    primary_cause: primary,
    composite_causes: compositeCauses.length ? compositeCauses : undefined,
    confidence: Math.round(((categoryScores[ranked[0]![0]] ?? 0) / Math.max(totalScore, 1)) * 100) / 100,
    critical_step: primaryViolations[0]?.step_index ?? null,
    category_scores: categoryScores,
    violations_by_category: Object.fromEntries(Object.entries(byCat).map(([k, v]) => [k, v.length])),
    top_violations: topViolations,
    explanation: explanationParts.join("\n"),
    recommended_actions: actions,
    telemetry_summary: checkerResult.telemetry_summary,
  };
}

export function attributeAll(checkerResults: CheckerResult[], trajectories: TrajectoryIR[]): Attribution[] {
  const map = new Map(trajectories.map((t) => [t.trajectory_id, t]));
  return checkerResults.map((cr) => attribute(cr, map.get(cr.trajectory_id)!));
}
