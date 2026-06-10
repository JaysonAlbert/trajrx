"""Deep phase-based manual-style attribution from Trajectory IR."""

from __future__ import annotations

from collections import Counter
from typing import Any


def _phase_for_turn(turn: int) -> str:
    if turn <= 5:
        return "P1_setup_and_structure"
    if turn <= 14:
        return "P2_db_env_debug"
    if turn <= 18:
        return "P3_data_fix_seed"
    return "P4_history_gen_wrapup"


def analyze_phases(traj: dict[str, Any]) -> dict[str, Any]:
    """Segment session by user_turn and compute per-phase tool profile."""
    steps = traj.get("steps") or []
    phases: dict[str, dict[str, Any]] = {}

    for s in steps:
        turn = s.get("telemetry", {}).get("user_turn", 0)
        phase = _phase_for_turn(turn)
        if phase not in phases:
            phases[phase] = {
                "steps": 0,
                "reads": 0,
                "shells": 0,
                "greps": 0,
                "mcps": 0,
                "writes": 0,
                "harness_runs": 0,
                "mcp_servers": Counter(),
            }
        p = phases[phase]
        tel = s.get("telemetry", {})
        p["steps"] += 1
        p["reads"] += tel.get("read_count", 0)
        p["shells"] += tel.get("shell_count", 0)
        p["greps"] += tel.get("grep_count", 0)
        p["mcps"] += tel.get("mcp_count", 0)
        for cmd in tel.get("shell_cmds", []):
            if "harness test run" in cmd:
                p["harness_runs"] += 1
        for tn in tel.get("tool_names", []):
            if tn in ("Write", "StrReplace"):
                p["writes"] += 1
        for m in tel.get("mcp_servers", []):
            p["mcp_servers"][m] += 1

    # Serialize counters
    for p in phases.values():
        p["mcp_servers"] = dict(p["mcp_servers"])

    return {"phases": phases, "phase_count": len(phases)}


def manual_attribution(traj: dict[str, Any]) -> dict[str, Any]:
    """
    Rule+heuristic attribution mimicking human transcript review.
    Returns multi-label causes with rationale (not LLM).
    """
    steps = traj.get("steps") or []
    meta = traj.get("metadata") or {}
    user_turns = meta.get("user_turns", 0)
    step_count = len(steps)

    total_reads = sum(s.get("telemetry", {}).get("read_count", 0) for s in steps)
    total_mcps = sum(s.get("telemetry", {}).get("mcp_count", 0) for s in steps)
    total_shells = sum(s.get("telemetry", {}).get("shell_count", 0) for s in steps)
    harness_runs = sum(
        1 for s in steps for cmd in s.get("telemetry", {}).get("shell_cmds", [])
        if "harness test run" in cmd
    )

    skill_reads = []
    for s in steps:
        skill_reads.extend(s.get("telemetry", {}).get("skill_reads", []))
        for p in s.get("telemetry", {}).get("read_paths", []):
            if "SKILL.md" in p or "/skills/" in p:
                skill_reads.append(p)
    harness_skill = any("harness" in p.lower() for p in skill_reads)

    causes: dict[str, float] = {}
    findings: list[str] = []

    # Scope creep: many user turns with evolving requirements
    if user_turns >= 20:
        causes["context"] = causes.get("context", 0) + 3
        findings.append(f"Scope creep: {user_turns} user turns with evolving requirements")

    if step_count / max(user_turns, 1) > 10:
        causes["context"] = causes.get("context", 0) + 2
        findings.append(f"Context bloat: {step_count} assistant steps / {user_turns} user turns")

    if total_reads > 80:
        causes["context"] = causes.get("context", 0) + 2
        findings.append(f"Excessive re-reads: {total_reads} Read calls")

    if harness_runs >= 6:
        causes["tool"] = causes.get("tool", 0) + 4
        findings.append(f"Harness trial-and-error: {harness_runs} test runs without converging")

    if total_shells > 80:
        causes["tool"] = causes.get("tool", 0) + 2
        findings.append(f"Shell-heavy debugging: {total_shells} shell invocations")

    if total_mcps > 100:
        causes["mcp"] = causes.get("mcp", 0) + 3
        findings.append(f"MCP thrashing: {total_mcps} DB/log queries (oracle-heavy)")

    instr = (traj.get("instruction") or "").lower()
    if "harness" in instr and harness_runs >= 4 and not harness_skill:
        causes["skill"] = causes.get("skill", 0) + 1
        findings.append("Harness task but harness SKILL workflow not consistently followed")

    # Multi-factor: if both mcp and tool high, note compound failure
    if not causes:
        causes["none"] = 1.0

    primary = max(causes.items(), key=lambda x: x[1])[0]
    total = sum(causes.values())
    ranked = sorted(causes.items(), key=lambda x: -x[1])

    return {
        "trajectory_id": traj.get("trajectory_id"),
        "primary_cause": primary,
        "confidence": round(causes[primary] / max(total, 1), 2),
        "category_scores": {k: round(v, 1) for k, v in causes.items()},
        "secondary_causes": [c for c, _ in ranked[1:3] if c != primary],
        "findings": findings,
        "phase_analysis": analyze_phases(traj),
        "harness_test_runs": harness_runs,
        "method": "manual_heuristic_v1",
    }
