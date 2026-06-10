"""Rule-based attribution from checker violations (no LLM)."""

from __future__ import annotations

from typing import Any

SEVERITY_WEIGHT = {"low": 1, "medium": 2, "high": 3, "critical": 4}

ACTIONS = {
    "context": [
        "Reduce parallel tool calls per turn; batch reads",
        "Summarize intermediate findings before next exploration wave",
        "Use subagent/Task for isolated exploration to avoid context bloat",
    ],
    "tool": [
        "Cache grep/read results; avoid repeating identical shell commands",
        "Fix root cause before re-running harness/e2e (check logs once, fix config)",
        "Narrow search scope with known file paths from docs",
    ],
    "mcp": [
        "Batch log queries; define SPL/query template upfront",
        "Verify MCP auth/connectivity before long debug loops",
        "Prefer code grep over repeated log MCP when source is local",
    ],
    "skill": [
        "Read relevant SKILL.md first and follow its workflow checklist",
        "If skill was read, enforce its steps before exploratory tooling",
    ],
}


def attribute(checker_result: dict[str, Any], traj: dict[str, Any]) -> dict[str, Any]:
    violations = checker_result.get("violations") or []
    if not violations:
        return {
            "trajectory_id": checker_result.get("trajectory_id"),
            "primary_cause": "none",
            "confidence": 1.0,
            "critical_step": None,
            "category_scores": {},
            "violations_by_category": {},
            "explanation": "No preset invariant violations detected.",
            "recommended_actions": [],
        }

    category_scores: dict[str, float] = {}
    by_cat: dict[str, list] = {}
    for v in violations:
        cat = v.get("category", "unknown")
        w = SEVERITY_WEIGHT.get(v.get("severity", "low"), 1)
        category_scores[cat] = category_scores.get(cat, 0) + w
        by_cat.setdefault(cat, []).append(v)

    primary = max(category_scores.items(), key=lambda x: x[1])[0]

    # Composite: top-2 within 35% of total → multi-factor session
    ranked = sorted(category_scores.items(), key=lambda x: -x[1])
    total_score = sum(category_scores.values())
    composite_causes: list[str] = []
    if len(ranked) >= 2 and total_score > 0:
        if ranked[1][1] / total_score >= 0.25:
            composite_causes = [ranked[0][0], ranked[1][0]]
            if ranked[0][1] - ranked[1][1] <= total_score * 0.15:
                primary = "compound"

    # critical step: earliest high/critical in primary category (or top category if compound)
    focus_cat = ranked[0][0] if primary == "compound" else primary
    primary_violations = sorted(
        by_cat.get(focus_cat, []),
        key=lambda v: (0 if v.get("severity") in ("high", "critical") else 1, v.get("step_index", 9999)),
    )
    critical_step = primary_violations[0].get("step_index") if primary_violations else None

    confidence = round(category_scores.get(ranked[0][0], 0) / max(total_score, 1), 2)

    top_violations = sorted(violations, key=lambda v: -SEVERITY_WEIGHT.get(v.get("severity", "low"), 1))[:5]

    explanation_parts = []
    if primary == "compound":
        explanation_parts.append(
            f"Compound cause: {composite_causes[0]} + {composite_causes[1]} "
            f"(scores {category_scores[composite_causes[0]]:.0f}/{category_scores[composite_causes[1]]:.0f}/{total_score:.0f})"
        )
    else:
        explanation_parts.append(f"Primary cause: {primary} (score {category_scores[primary]:.0f}/{total_score:.0f})")
    for v in top_violations[:3]:
        explanation_parts.append(f"- [{v['invariant_id']}] step {v['step_index']}: {v['message']}")

    action_cats = composite_causes if primary == "compound" else [primary]
    actions: list[str] = []
    for cat in action_cats:
        actions.extend(ACTIONS.get(cat, []))

    return {
        "trajectory_id": checker_result.get("trajectory_id"),
        "primary_cause": primary,
        "composite_causes": composite_causes,
        "confidence": confidence,
        "critical_step": critical_step,
        "category_scores": category_scores,
        "violations_by_category": {k: len(v) for k, v in by_cat.items()},
        "top_violations": top_violations,
        "explanation": "\n".join(explanation_parts),
        "recommended_actions": actions,
        "telemetry_summary": checker_result.get("telemetry_summary"),
    }


def attribute_all(checker_results: list[dict[str, Any]], trajectories: list[dict[str, Any]]) -> list[dict[str, Any]]:
    traj_map = {t["trajectory_id"]: t for t in trajectories}
    out = []
    for cr in checker_results:
        tid = cr.get("trajectory_id")
        out.append(attribute(cr, traj_map.get(tid, {})))
    return out
