"""Convert Cursor JSONL events to canonical Trajectory IR."""

from __future__ import annotations

import json
import re
from typing import Any

from doctor.ir.schema import validate_ir

USER_QUERY_RE = re.compile(r"<user_query>\s*(.*?)\s*</user_query>", re.DOTALL)


def _extract_user_text(content: str) -> str:
    m = USER_QUERY_RE.search(content)
    if m:
        return m.group(1).strip()
    return content.strip()


def _tool_role(name: str, inp: dict[str, Any]) -> str:
    if name == "CallMcpTool":
        server = inp.get("server") or inp.get("mcpServer") or "unknown"
        tool = inp.get("toolName") or ""
        return f"mcp:{server}" + (f"/{tool}" if tool else "")
    return f"tool:{name}"


def _tool_content(name: str, inp: dict[str, Any]) -> str:
    try:
        return json.dumps(inp, ensure_ascii=False)[:4000]
    except Exception:
        return str(inp)[:4000]


def _parse_assistant_content(content_list: list[dict[str, Any]]) -> list[dict[str, Any]]:
    substeps: list[dict[str, Any]] = []
    sub_idx = 0
    for item in content_list:
        t = item.get("type")
        if t == "text":
            text = str(item.get("text") or "").strip()
            if text:
                sub_idx += 1
                substeps.append({
                    "sub_index": sub_idx,
                    "role": "assistant",
                    "content": text[:8000],
                })
        elif t == "tool_use":
            name = str(item.get("name") or "unknown")
            inp = item.get("input") or {}
            sub_idx += 1
            substeps.append({
                "sub_index": sub_idx,
                "role": _tool_role(name, inp),
                "content": _tool_content(name, inp),
                "tool_name": name,
                "tool_input": inp,
            })
    return substeps


def _step_telemetry(substeps: list[dict[str, Any]], user_turn: int) -> dict[str, Any]:
    tool_names: list[str] = []
    mcp_servers: list[str] = []
    shell_cmds: list[str] = []
    grep_patterns: list[str] = []
    read_paths: list[str] = []
    skill_reads: list[str] = []

    for sub in substeps:
        role = sub.get("role", "")
        inp = sub.get("tool_input") or {}
        name = sub.get("tool_name") or ""

        if role.startswith("tool:"):
            tool_names.append(name or role.split(":", 1)[-1])
        if role.startswith("mcp:"):
            mcp_servers.append(role.split(":", 1)[-1].split("/")[0])

        if name == "Shell":
            cmd = str(inp.get("command") or "")
            if cmd:
                shell_cmds.append(cmd.strip())
        elif name == "Grep":
            pat = str(inp.get("pattern") or "")
            if pat:
                grep_patterns.append(pat)
        elif name == "Read":
            path = str(inp.get("path") or "")
            if path:
                read_paths.append(path)
                if "SKILL.md" in path or "/skills/" in path:
                    skill_reads.append(path)

    return {
        "user_turn": user_turn,
        "tool_count": len([s for s in substeps if s.get("role", "").startswith(("tool:", "mcp:"))]),
        "mcp_count": len(mcp_servers),
        "shell_count": len(shell_cmds),
        "read_count": len(read_paths),
        "grep_count": len(grep_patterns),
        "assistant_chars": sum(len(s.get("content", "")) for s in substeps if s.get("role") == "assistant"),
        "tool_names": tool_names,
        "mcp_servers": mcp_servers,
        "shell_cmds": shell_cmds,
        "grep_patterns": grep_patterns,
        "read_paths": read_paths,
        "skill_reads": skill_reads,
    }


def cursor_ir(trajectories: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []

    for traj in trajectories:
        trajectory_id = str(traj.get("trajectory_id") or "unknown")
        events = traj.get("events") or []
        source_path = traj.get("_source_path", "")

        instruction = str(traj.get("instruction") or "")
        user_turn = 0
        steps: list[dict[str, Any]] = []
        step_idx = 0

        for event in events:
            role = event.get("role")
            msg = event.get("message") or {}
            content_list = msg.get("content") or []

            if role == "user":
                user_turn += 1
                for item in content_list:
                    if item.get("type") == "text":
                        text = _extract_user_text(str(item.get("text") or ""))
                        if text and not instruction:
                            instruction = text[:2000]
                continue

            if role != "assistant":
                continue

            substeps = _parse_assistant_content(content_list)
            if not substeps:
                continue

            step_idx += 1
            telemetry = _step_telemetry(substeps, user_turn)
            steps.append({
                "index": step_idx,
                "telemetry": telemetry,
                "substeps": substeps,
            })

        ir = {
            "trajectory_id": trajectory_id,
            "source": "cursor",
            "instruction": instruction,
            "metadata": {
                "source_path": source_path,
                "event_count": len(events),
                "step_count": len(steps),
                "user_turns": user_turn,
            },
            "steps": steps,
        }
        validate_ir(ir)
        out.append(ir)

    return out
