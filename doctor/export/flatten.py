"""Flatten Cursor JSONL transcript to a single linear Markdown file for AI reading."""

from __future__ import annotations

import json
import os
import re
from typing import Any

USER_QUERY_RE = re.compile(r"<user_query>\s*(.*?)\s*</user_query>", re.DOTALL)
REDACTED_RE = re.compile(r"\[REDACTED\]")


def _extract_user_text(raw: str) -> str:
    m = USER_QUERY_RE.search(raw)
    if m:
        return m.group(1).strip()
    # strip image_files blocks for readability
    text = re.sub(r"<image_files>.*?</image_files>", "", raw, flags=re.DOTALL)
    text = re.sub(r"\[Image\]\s*", "", text)
    return text.strip()


def _truncate(s: str, max_chars: int) -> str:
    if max_chars <= 0 or len(s) <= max_chars:
        return s
    return s[: max_chars - 20] + "\n\n… [truncated]"


def _format_tool_block(name: str, inp: dict[str, Any], max_tool_chars: int) -> str:
    lines = [f"### Tool: `{name}`", ""]

    if name == "CallMcpTool":
        server = inp.get("server") or "unknown"
        tool = inp.get("toolName") or "unknown"
        args = inp.get("arguments") or {}
        lines.append(f"- **MCP server:** `{server}`")
        lines.append(f"- **Tool:** `{tool}`")
        if args:
            body = json.dumps(args, ensure_ascii=False, indent=2)
            lines.extend(["", "```json", _truncate(body, max_tool_chars), "```"])
        return "\n".join(lines)

    if name == "Shell":
        cmd = inp.get("command") or ""
        desc = inp.get("description") or ""
        if desc:
            lines.append(f"- {desc}")
        lines.extend(["", "```bash", _truncate(str(cmd), max_tool_chars), "```"])
        return "\n".join(lines)

    if name == "Read":
        path = inp.get("path") or ""
        offset = inp.get("offset")
        limit = inp.get("limit")
        extra = []
        if offset is not None:
            extra.append(f"offset={offset}")
        if limit is not None:
            extra.append(f"limit={limit}")
        suffix = f" ({', '.join(extra)})" if extra else ""
        lines.append(f"- **path:** `{path}`{suffix}")
        return "\n".join(lines)

    if name == "Grep":
        lines.append(f"- **pattern:** `{inp.get('pattern', '')}`")
        if inp.get("path"):
            lines.append(f"- **path:** `{inp.get('path')}`")
        if inp.get("glob"):
            lines.append(f"- **glob:** `{inp.get('glob')}`")
        return "\n".join(lines)

    if name in ("Write", "StrReplace"):
        lines.append(f"- **path:** `{inp.get('path', '')}`")
        if name == "StrReplace" and inp.get("old_string"):
            old = str(inp["old_string"])[:200]
            lines.append(f"- **old (preview):** `{old}…`" if len(str(inp["old_string"])) > 200 else f"- **old:** `{old}`")
        return "\n".join(lines)

    if name == "Glob":
        lines.append(f"- **pattern:** `{inp.get('glob_pattern', '')}`")
        if inp.get("target_directory"):
            lines.append(f"- **dir:** `{inp.get('target_directory')}`")
        return "\n".join(lines)

    if name == "Task":
        lines.append(f"- **subagent:** `{inp.get('subagent_type', '')}`")
        if inp.get("description"):
            lines.append(f"- **description:** {inp.get('description')}")
        return "\n".join(lines)

    body = json.dumps(inp, ensure_ascii=False, indent=2)
    lines.extend(["", "```json", _truncate(body, max_tool_chars), "```"])
    return "\n".join(lines)


def flatten_events_to_markdown(
    events: list[dict[str, Any]],
    *,
    trajectory_id: str = "unknown",
    source_path: str = "",
    max_tool_chars: int = 4000,
    max_assistant_chars: int = 8000,
    include_step_index: bool = True,
) -> str:
    """Convert raw Cursor JSONL events to flat chronological Markdown."""
    user_turn = 0
    step_idx = 0
    instruction = ""

    parts: list[str] = [
        f"# Cursor Session Transcript",
        "",
        "## Metadata",
        "",
        f"| Field | Value |",
        f"|-------|-------|",
        f"| session_id | `{trajectory_id}` |",
    ]
    if source_path:
        parts.append(f"| source | `{source_path}` |")
    parts.extend([
        "",
        "> Flattened by **doctor** for AI attribution reading. Chronological, one section per user message or assistant step.",
        "",
    ])

    body_parts: list[str] = []

    for event in events:
        role = event.get("role")
        msg = event.get("message") or {}
        content_list = msg.get("content") or []

        if role == "user":
            user_turn += 1
            texts = []
            for item in content_list:
                if item.get("type") == "text":
                    texts.append(_extract_user_text(str(item.get("text") or "")))
            user_text = "\n\n".join(t for t in texts if t).strip()
            if user_text and not instruction:
                instruction = user_text[:2000]

            body_parts.extend([
                "---",
                "",
                f"## User Turn {user_turn} (#U{user_turn})",
                "",
                user_text or "_(empty user message)_",
                "",
            ])
            continue

        if role != "assistant":
            continue

        step_idx += 1
        header = f"## Assistant Step {step_idx} (#S{step_idx}, user_turn={user_turn})"
        if include_step_index:
            header = f"## Assistant Step {step_idx} (#S{step_idx}, after #U{user_turn})"

        body_parts.extend(["---", "", header, ""])

        for item in content_list:
            t = item.get("type")
            if t == "text":
                text = str(item.get("text") or "").strip()
                text = REDACTED_RE.sub("_[thinking redacted]_", text)
                if text:
                    body_parts.extend(["", _truncate(text, max_assistant_chars), ""])
            elif t == "tool_use":
                name = str(item.get("name") or "unknown")
                inp = item.get("input") or {}
                body_parts.extend(["", _format_tool_block(name, inp, max_tool_chars), ""])

    if instruction:
        parts.extend([
            "## Task (first user message)",
            "",
            instruction,
            "",
        ])

    parts.extend(["## Conversation", ""])
    parts.extend(body_parts)

    # footer stats
    parts.extend([
        "---",
        "",
        "## Session Stats",
        "",
        f"- user_turns: {user_turn}",
        f"- assistant_steps: {step_idx}",
        "",
    ])

    return "\n".join(parts)


def flatten_file(
    input_path: str,
    output_path: str | None = None,
    *,
    max_tool_chars: int = 4000,
    max_assistant_chars: int = 8000,
) -> str:
    """Read JSONL file and write flat Markdown."""
    from doctor.ir.loader import load_trajectories

    raw = load_trajectories(input_path)
    traj = raw[0]
    events = traj.get("events") or []
    tid = traj.get("trajectory_id") or os.path.splitext(os.path.basename(input_path))[0]

    md = flatten_events_to_markdown(
        events,
        trajectory_id=tid,
        source_path=input_path,
        max_tool_chars=max_tool_chars,
        max_assistant_chars=max_assistant_chars,
    )

    if output_path is None:
        stem = os.path.splitext(os.path.basename(input_path))[0]
        output_path = os.path.join(os.path.dirname(input_path), f"{stem}.flat.md")

    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(md)
    return output_path


def append_attribution_section(md_path: str, attribution: dict[str, Any], violations: list[dict[str, Any]] | None = None) -> None:
    """Append static attribution summary to an existing flat markdown file."""
    lines = [
        "",
        "---",
        "",
        "## Attribution Summary (doctor)",
        "",
        f"- **primary_cause:** {attribution.get('primary_cause')}",
        f"- **confidence:** {attribution.get('confidence')}",
        f"- **critical_step:** {attribution.get('critical_step')}",
        "",
    ]
    if attribution.get("composite_causes"):
        lines.append(f"- **composite:** {', '.join(attribution['composite_causes'])}")
        lines.append("")

    scores = attribution.get("category_scores") or {}
    if scores:
        lines.append("### Category scores")
        lines.append("")
        for cat, sc in sorted(scores.items(), key=lambda x: -x[1]):
            lines.append(f"- {cat}: {sc}")
        lines.append("")

    if violations:
        lines.append("### Top violations")
        lines.append("")
        for v in violations[:8]:
            lines.append(f"- `[{v.get('severity')}]` **{v.get('invariant_id')}** @ step {v.get('step_index')}: {v.get('message')}")
        lines.append("")

    with open(md_path, "a", encoding="utf-8") as f:
        f.write("\n".join(lines))
