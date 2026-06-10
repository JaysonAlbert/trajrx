"""Generate human-readable reports from pipeline outputs."""

from __future__ import annotations

import json
from typing import Any


def build_report(
    traj: dict[str, Any],
    checker_result: dict[str, Any],
    attribution: dict[str, Any],
) -> str:
    tel = checker_result.get("telemetry_summary") or {}
    lines = [
        f"# Doctor Attribution Report",
        "",
        f"**Session:** `{traj.get('trajectory_id')}`",
        f"**Source:** {traj.get('source', 'unknown')}",
        "",
        "## Task",
        "",
        (traj.get("instruction") or "(no instruction)")[:1500],
        "",
        "## Summary",
        "",
        f"| Metric | Value |",
        f"|--------|-------|",
        f"| Primary cause | **{attribution.get('primary_cause')}** (confidence {attribution.get('confidence')}) |",
        f"| Critical step | {attribution.get('critical_step')} |",
        f"| Assistant steps | {tel.get('step_count', 0)} |",
        f"| User turns | {tel.get('user_turns', 0)} |",
        f"| Total tool calls | {tel.get('total_tool_calls', 0)} |",
        f"| MCP calls | {tel.get('total_mcp_calls', 0)} |",
        f"| Shell calls | {tel.get('total_shell_calls', 0)} |",
        f"| Read calls | {tel.get('total_read_calls', 0)} |",
        f"| Grep calls | {tel.get('total_grep_calls', 0)} |",
        f"| Violations | {checker_result.get('violation_count', 0)} |",
        "",
        "## Category Scores",
        "",
    ]

    for cat, score in sorted((attribution.get("category_scores") or {}).items(), key=lambda x: -x[1]):
        lines.append(f"- **{cat}**: {score}")

    lines.extend(["", "## Top Violations", ""])
    for v in (attribution.get("top_violations") or [])[:10]:
        lines.append(f"- `[{v.get('severity')}]` **{v.get('invariant_id')}** @ step {v.get('step_index')}: {v.get('message')}")

    tb = tel.get("tool_breakdown") or {}
    if tb:
        lines.extend(["", "## Tool Breakdown", ""])
        for name, cnt in list(tb.items())[:15]:
            lines.append(f"- `{name}`: {cnt}")

    mb = tel.get("mcp_breakdown") or {}
    if mb:
        lines.extend(["", "## MCP Breakdown", ""])
        for name, cnt in list(mb.items())[:10]:
            lines.append(f"- `{name}`: {cnt}")

    actions = attribution.get("recommended_actions") or []
    if actions:
        lines.extend(["", "## Recommended Actions", ""])
        for a in actions:
            lines.append(f"- {a}")

    lines.extend(["", "## Explanation", "", attribution.get("explanation", "")])
    return "\n".join(lines)


def write_report(
    traj: dict[str, Any],
    checker_result: dict[str, Any],
    attribution: dict[str, Any],
    out_path: str,
) -> None:
    content = build_report(traj, checker_result, attribution)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(content)


def write_metrics(attributions: list[dict[str, Any]], out_path: str) -> None:
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(attributions, f, ensure_ascii=False, indent=2)
