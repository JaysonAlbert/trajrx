"""Preset static invariants for IDE agent efficiency attribution."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

Severity = str  # low | medium | high | critical
Category = str  # context | tool | mcp | skill


@dataclass
class Violation:
    invariant_id: str
    category: Category
    step_index: int
    severity: Severity
    message: str
    evidence: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "invariant_id": self.invariant_id,
            "category": self.category,
            "step_index": self.step_index,
            "severity": self.severity,
            "message": self.message,
            "evidence": self.evidence,
        }


@dataclass
class Invariant:
    invariant_id: str
    category: Category
    description: str
    check_fn: Callable[[dict[str, Any], list[dict[str, Any]]], list[Violation]]


def _inv_ctx_001(traj: dict[str, Any], steps: list[dict[str, Any]]) -> list[Violation]:
    """Single step with too many tool calls (>8)."""
    out = []
    for s in steps:
        tc = s.get("telemetry", {}).get("tool_count", 0)
        if tc > 8:
            out.append(Violation(
                "INV-CTX-001", "context", s["index"], "medium",
                f"Step {s['index']} has {tc} tool calls in one turn (threshold 8)",
                {"tool_count": tc},
            ))
    return out


def _inv_ctx_002(traj: dict[str, Any], steps: list[dict[str, Any]]) -> list[Violation]:
    """Excessive Read operations across session (>40)."""
    total_reads = sum(s.get("telemetry", {}).get("read_count", 0) for s in steps)
    if total_reads > 40:
        return [Violation(
            "INV-CTX-002", "context", steps[-1]["index"] if steps else 0, "high",
            f"Session has {total_reads} Read operations (threshold 40)",
            {"total_reads": total_reads},
        )]
    return []


def _inv_ctx_003(traj: dict[str, Any], steps: list[dict[str, Any]]) -> list[Violation]:
    """Agent self-spin: many assistant steps per user turn."""
    if not steps:
        return []
    user_turns = traj.get("metadata", {}).get("user_turns", 1) or 1
    ratio = len(steps) / max(user_turns, 1)
    if ratio > 12:
        return [Violation(
            "INV-CTX-003", "context", steps[len(steps) // 2]["index"], "high",
            f"High assistant/user ratio {ratio:.1f}:1 ({len(steps)} steps / {user_turns} user turns)",
            {"step_count": len(steps), "user_turns": user_turns, "ratio": round(ratio, 2)},
        )]
    return []


def _inv_tool_001(traj: dict[str, Any], steps: list[dict[str, Any]]) -> list[Violation]:
    """Repeated Grep pattern >= 3 times."""
    from collections import Counter
    patterns: Counter[str] = Counter()
    first_step: dict[str, int] = {}
    for s in steps:
        for pat in s.get("telemetry", {}).get("grep_patterns", []):
            patterns[pat] += 1
            first_step.setdefault(pat, s["index"])
    out = []
    for pat, cnt in patterns.items():
        if cnt >= 3:
            out.append(Violation(
                "INV-TOOL-001", "tool", first_step[pat], "medium",
                f"Grep pattern repeated {cnt} times",
                {"pattern": pat[:200], "count": cnt},
            ))
    return out


def _inv_tool_002(traj: dict[str, Any], steps: list[dict[str, Any]]) -> list[Violation]:
    """Repeated Shell command >= 2 times."""
    from collections import Counter
    cmds: Counter[str] = Counter()
    first_step: dict[str, int] = {}
    for s in steps:
        for cmd in s.get("telemetry", {}).get("shell_cmds", []):
            norm = " ".join(cmd.split())[:500]
            cmds[norm] += 1
            first_step.setdefault(norm, s["index"])
    out = []
    for cmd, cnt in cmds.items():
        if cnt >= 2:
            out.append(Violation(
                "INV-TOOL-002", "tool", first_step[cmd], "medium",
                f"Shell command repeated {cnt} times",
                {"command": cmd[:300], "count": cnt},
            ))
    return out


def _inv_tool_003(traj: dict[str, Any], steps: list[dict[str, Any]]) -> list[Violation]:
    """Many harness test retries (harness test run >= 4)."""
    harness_runs = 0
    first_idx = 0
    for s in steps:
        for cmd in s.get("telemetry", {}).get("shell_cmds", []):
            if "harness test run" in cmd:
                harness_runs += 1
                if first_idx == 0:
                    first_idx = s["index"]
    if harness_runs >= 4:
        return [Violation(
            "INV-TOOL-003", "tool", first_idx or 1, "high",
            f"Harness test run invoked {harness_runs} times (trial-and-error loop)",
            {"harness_test_runs": harness_runs},
        )]
    return []


def _inv_mcp_001(traj: dict[str, Any], steps: list[dict[str, Any]]) -> list[Violation]:
    """MCP-heavy session: MCP calls > 30% of tools and total tools > 50."""
    total_tools = sum(s.get("telemetry", {}).get("tool_count", 0) for s in steps)
    mcp_calls = sum(s.get("telemetry", {}).get("mcp_count", 0) for s in steps)
    if total_tools > 50 and mcp_calls / max(total_tools, 1) > 0.3:
        return [Violation(
            "INV-MCP-001", "mcp", steps[-1]["index"] if steps else 0, "medium",
            f"MCP calls {mcp_calls}/{total_tools} ({100*mcp_calls/max(total_tools,1):.0f}%) — MCP-heavy exploration",
            {"mcp_calls": mcp_calls, "total_tools": total_tools},
        )]
    return []


def _inv_mcp_002(traj: dict[str, Any], steps: list[dict[str, Any]]) -> list[Violation]:
    """Excessive MCP tool usage (>100) suggesting log/query thrashing."""
    mcp_calls = sum(s.get("telemetry", {}).get("mcp_count", 0) for s in steps)
    if mcp_calls > 100:
        return [Violation(
            "INV-MCP-002", "mcp", steps[len(steps)//2]["index"], "high",
            f"Excessive MCP invocations: {mcp_calls} (possible log/query thrashing)",
            {"mcp_calls": mcp_calls},
        )]
    return []


def _inv_skill_001(traj: dict[str, Any], steps: list[dict[str, Any]]) -> list[Violation]:
    """Skill read but continued heavy exploration without deliverable writes."""
    skill_read = any(s.get("telemetry", {}).get("skill_reads") for s in steps)
    total_read = sum(s.get("telemetry", {}).get("read_count", 0) for s in steps)
    total_grep = sum(s.get("telemetry", {}).get("grep_count", 0) for s in steps)
    write_count = sum(
        1 for s in steps
        for tn in s.get("telemetry", {}).get("tool_names", [])
        if tn in ("Write", "StrReplace")
    )
    if skill_read and (total_read + total_grep) > 30 and write_count < 3:
        return [Violation(
            "INV-SKILL-001", "skill", steps[-1]["index"], "medium",
            f"Skill loaded but exploration-heavy ({total_read} reads, {total_grep} greps, {write_count} writes)",
            {"reads": total_read, "greps": total_grep, "writes": write_count},
        )]
    return []


def _inv_skill_002(traj: dict[str, Any], steps: list[dict[str, Any]]) -> list[Violation]:
    """Harness task without reading harness skill."""
    instr = (traj.get("instruction") or "").lower()
    if "harness" not in instr:
        return []
    harness_skill = any(
        "harness" in p.lower() and "skill" in p.lower()
        for s in steps
        for p in s.get("telemetry", {}).get("skill_reads", [])
    )
    harness_skill_read = any(
        "/harness/SKILL.md" in p or "skills/harness" in p.lower()
        for s in steps
        for p in s.get("telemetry", {}).get("skill_reads", [])
    )
    if not harness_skill_read and not harness_skill:
        # check if Read path contains harness skill
        read_harness = any(
            "harness/SKILL.md" in p
            for s in steps
            for p in s.get("telemetry", {}).get("read_paths", [])
        )
        if not read_harness:
            return [Violation(
                "INV-SKILL-002", "skill", 1, "low",
                "Task mentions harness but harness SKILL.md was not read early",
                {"instruction_snippet": instr[:200]},
            )]
    return []


def _inv_ctx_004(traj: dict[str, Any], steps: list[dict[str, Any]]) -> list[Violation]:
    """Scope creep: many user turns (>=20) with low write ratio."""
    user_turns = traj.get("metadata", {}).get("user_turns", 0)
    writes = sum(
        1 for s in steps
        for tn in s.get("telemetry", {}).get("tool_names", [])
        if tn in ("Write", "StrReplace")
    )
    if user_turns >= 20 and writes < 15:
        return [Violation(
            "INV-CTX-004", "context", steps[-1]["index"] if steps else 0, "high",
            f"Scope creep: {user_turns} user turns but only {writes} write/edit ops",
            {"user_turns": user_turns, "writes": writes},
        )]
    return []


PRESET_INVARIANTS: list[Invariant] = [
    Invariant("INV-CTX-001", "context", "Too many tools per step", _inv_ctx_001),
    Invariant("INV-CTX-002", "context", "Excessive Read ops", _inv_ctx_002),
    Invariant("INV-CTX-003", "context", "High assistant/user ratio", _inv_ctx_003),
    Invariant("INV-CTX-004", "context", "Scope creep low delivery", _inv_ctx_004),
    Invariant("INV-TOOL-001", "tool", "Repeated Grep", _inv_tool_001),
    Invariant("INV-TOOL-002", "tool", "Repeated Shell", _inv_tool_002),
    Invariant("INV-TOOL-003", "tool", "Harness retry loop", _inv_tool_003),
    Invariant("INV-MCP-001", "mcp", "MCP-heavy session", _inv_mcp_001),
    Invariant("INV-MCP-002", "mcp", "MCP thrashing", _inv_mcp_002),
    Invariant("INV-SKILL-001", "skill", "Skill read but over-explore", _inv_skill_001),
    Invariant("INV-SKILL-002", "skill", "Missing harness skill", _inv_skill_002),
]


def export_static_invariants() -> list[dict[str, Any]]:
    return [
        {"invariant_id": inv.invariant_id, "category": inv.category, "description": inv.description}
        for inv in PRESET_INVARIANTS
    ]
