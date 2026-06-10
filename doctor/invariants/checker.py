"""Run preset invariants against Trajectory IR."""

from __future__ import annotations

import json
from typing import Any

from doctor.invariants.presets import PRESET_INVARIANTS, Violation, export_static_invariants


SEVERITY_WEIGHT = {"low": 1, "medium": 2, "high": 3, "critical": 4}


def check_trajectory(traj: dict[str, Any]) -> dict[str, Any]:
    steps = traj.get("steps") or []
    violations: list[Violation] = []
    for inv in PRESET_INVARIANTS:
        try:
            violations.extend(inv.check_fn(traj, steps))
        except Exception as e:
            violations.append(Violation(
                inv.invariant_id, inv.category, 0, "low",
                f"Invariant check error: {e}",
                {"error": str(e)},
            ))

    telemetry = _aggregate_telemetry(traj, steps)

    return {
        "trajectory_id": traj.get("trajectory_id"),
        "violations": [v.to_dict() for v in violations],
        "violation_count": len(violations),
        "telemetry_summary": telemetry,
    }


def check_all(trajectories: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [check_trajectory(t) for t in trajectories]


def _aggregate_telemetry(traj: dict[str, Any], steps: list[dict[str, Any]]) -> dict[str, Any]:
    tool_names: dict[str, int] = {}
    mcp_servers: dict[str, int] = {}
    for s in steps:
        tel = s.get("telemetry", {})
        for n in tel.get("tool_names", []):
            tool_names[n] = tool_names.get(n, 0) + 1
        for m in tel.get("mcp_servers", []):
            mcp_servers[m] = mcp_servers.get(m, 0) + 1

    return {
        "step_count": len(steps),
        "user_turns": traj.get("metadata", {}).get("user_turns", 0),
        "total_tool_calls": sum(s.get("telemetry", {}).get("tool_count", 0) for s in steps),
        "total_mcp_calls": sum(s.get("telemetry", {}).get("mcp_count", 0) for s in steps),
        "total_shell_calls": sum(s.get("telemetry", {}).get("shell_count", 0) for s in steps),
        "total_read_calls": sum(s.get("telemetry", {}).get("read_count", 0) for s in steps),
        "total_grep_calls": sum(s.get("telemetry", {}).get("grep_count", 0) for s in steps),
        "tool_breakdown": dict(sorted(tool_names.items(), key=lambda x: -x[1])),
        "mcp_breakdown": dict(sorted(mcp_servers.items(), key=lambda x: -x[1])),
    }


def write_checker_results(results: list[dict[str, Any]], out_dir: str) -> str:
    import os
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, "violations.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    static_path = os.path.join(out_dir, "static_invariants.json")
    with open(static_path, "w", encoding="utf-8") as f:
        json.dump(export_static_invariants(), f, ensure_ascii=False, indent=2)
    return path
