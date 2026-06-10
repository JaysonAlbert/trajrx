"""Compare static checker attribution vs manual heuristic attribution."""

from __future__ import annotations

from typing import Any


def reconcile(
    static_attr: dict[str, Any],
    manual_attr: dict[str, Any],
) -> dict[str, Any]:
    static_primary = static_attr.get("primary_cause")
    manual_primary = manual_attr.get("primary_cause")

    static_scores = static_attr.get("category_scores") or {}
    manual_scores = manual_attr.get("category_scores") or {}

    all_cats = set(static_scores) | set(manual_scores)
    score_diffs = {
        cat: {
            "static": static_scores.get(cat, 0),
            "manual": manual_scores.get(cat, 0),
            "delta": round(manual_scores.get(cat, 0) - static_scores.get(cat, 0), 1),
        }
        for cat in sorted(all_cats)
    }

    primary_match = (
        static_primary == manual_primary
        or (static_primary == "compound" and manual_primary in (static_attr.get("composite_causes") or []))
        or (manual_primary in (static_attr.get("composite_causes") or []) and static_primary == manual_primary)
    )
    static_composite = static_attr.get("composite_causes") or []
    manual_secondary = manual_attr.get("secondary_causes") or []
    if not primary_match and static_primary in manual_secondary:
        primary_match = True
        notes_extra = "Manual secondary includes static primary"
    else:
        notes_extra = None

    # Top-2 overlap: do both methods rank same categories highly?
    static_ranked = sorted(static_scores.items(), key=lambda x: -x[1])[:2]
    manual_ranked = sorted(manual_scores.items(), key=lambda x: -x[1])[:2]
    static_top2 = {c for c, _ in static_ranked}
    manual_top2 = {c for c, _ in manual_ranked}
    top2_overlap = static_top2 & manual_top2

    verdict = "consistent" if primary_match else "partial"
    if not primary_match and not top2_overlap:
        verdict = "divergent"

    notes = []
    if primary_match:
        notes.append(f"Primary cause agrees: **{static_primary}**")
    else:
        notes.append(
            f"Primary cause differs: static={static_primary} vs manual={manual_primary}"
        )
    if static_composite:
        notes.append(f"Static composite: {', '.join(static_composite)}")
    if notes_extra:
        notes.append(notes_extra)
    if top2_overlap:
        notes.append(f"Top-2 overlap: {', '.join(sorted(top2_overlap))}")
    else:
        notes.append("No top-2 category overlap")

    static_only = [v for v in static_attr.get("top_violations", [])[:3]]
    manual_only = manual_attr.get("findings", [])[:3]

    return {
        "trajectory_id": static_attr.get("trajectory_id"),
        "verdict": verdict,
        "primary_match": primary_match,
        "static_primary": static_primary,
        "manual_primary": manual_primary,
        "static_confidence": static_attr.get("confidence"),
        "manual_confidence": manual_attr.get("confidence"),
        "score_diffs": score_diffs,
        "top2_overlap": list(top2_overlap),
        "notes": notes,
        "static_evidence": [
            f"[{v.get('invariant_id')}] {v.get('message')}" for v in static_only
        ],
        "manual_evidence": manual_only,
    }


def format_reconcile_report(rec: dict[str, Any]) -> str:
    lines = [
        "# Attribution Reconciliation",
        "",
        f"**Verdict:** {rec.get('verdict')} (primary_match={rec.get('primary_match')})",
        "",
        f"| Method | Primary | Confidence |",
        f"|--------|---------|------------|",
        f"| Static (Checker) | {rec.get('static_primary')} | {rec.get('static_confidence')} |",
        f"| Manual (Heuristic) | {rec.get('manual_primary')} | {rec.get('manual_confidence')} |",
        "",
        "## Category Score Comparison",
        "",
    ]
    for cat, d in rec.get("score_diffs", {}).items():
        lines.append(f"- **{cat}**: static={d['static']}, manual={d['manual']}, Δ={d['delta']}")

    lines.extend(["", "## Notes", ""])
    for n in rec.get("notes", []):
        lines.append(f"- {n}")

    lines.extend(["", "## Static Evidence", ""])
    for e in rec.get("static_evidence", []):
        lines.append(f"- {e}")

    lines.extend(["", "## Manual Evidence", ""])
    for e in rec.get("manual_evidence", []):
        lines.append(f"- {e}")

    return "\n".join(lines)
