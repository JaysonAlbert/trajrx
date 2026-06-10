"""Load raw trajectory files (JSON, JSONL)."""

from __future__ import annotations

import json
import os
from typing import Any

PREFERRED_KEYS = ("traj", "events", "messages", "trajectory", "spans")
ID_KEYS = ("trajectory_id", "task_id", "traceId", "session_id")


def filename_stem(path: str) -> str:
    base = os.path.basename(path)
    stem, _ = os.path.splitext(base)
    return stem or "trajectory"


def extract_id(d: dict[str, Any]) -> str | None:
    for k in ID_KEYS:
        v = d.get(k)
        if v is not None:
            s = str(v).strip()
            if s:
                return s
    return None


def extract_events(obj: dict[str, Any]) -> list[dict[str, Any]]:
    for k in PREFERRED_KEYS:
        v = obj.get(k)
        if isinstance(v, list):
            if not all(isinstance(x, dict) for x in v):
                raise ValueError(f'"{k}" must be list[dict]')
            return v
    return [obj]


def extract_instruction(container: Any, events: list[dict[str, Any]]) -> str:
    if isinstance(container, dict):
        for k in ("instruction", "task"):
            v = container.get(k)
            if v is not None:
                return str(v).strip()
    for e in events:
        role = str(e.get("role") or e.get("source") or "").lower()
        if role in ("user", "human"):
            content = e.get("content") or e.get("message") or ""
            if content:
                return str(content).strip()[:2000]
    return ""


def load_trajectories(path: str) -> list[dict[str, Any]]:
    """Load trajectory wrapper(s) from JSON or JSONL."""
    raw = open(path, "r", encoding="utf-8-sig").read().strip()
    default_tid = filename_stem(path)

    if not raw:
        return [{"trajectory_id": default_tid, "instruction": "", "events": [], "_source_path": path}]

    # JSONL: one object per line (Cursor format)
    if path.endswith(".jsonl") or _looks_like_jsonl(raw):
        events: list[dict[str, Any]] = []
        for line in raw.splitlines():
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            if not isinstance(obj, dict):
                raise ValueError("JSONL lines must be objects")
            events.append(obj)
        return [{
            "trajectory_id": default_tid,
            "instruction": "",
            "events": events,
            "_source_path": path,
            "_format": "cursor_jsonl",
        }]

    try:
        obj = json.loads(raw)
    except json.JSONDecodeError:
        raise ValueError(f"Unrecognized file format: {path}")

    if isinstance(obj, dict):
        events = extract_events(obj)
        tid = extract_id(obj) or default_tid
        instr = extract_instruction(obj, events)
        return [{"trajectory_id": tid, "instruction": instr, "events": events, "_source_path": path}]

    if isinstance(obj, list):
        if not obj:
            return [{"trajectory_id": default_tid, "instruction": "", "events": [], "_source_path": path}]
        if all(isinstance(x, dict) and not any(k in x for k in PREFERRED_KEYS) for x in obj):
            return [{
                "trajectory_id": default_tid,
                "instruction": extract_instruction(obj, obj),
                "events": obj,
                "_source_path": path,
            }]
        out = []
        for idx, w in enumerate(obj):
            events = extract_events(w)
            tid = extract_id(w) or f"{default_tid}__{idx + 1}"
            out.append({
                "trajectory_id": tid,
                "instruction": extract_instruction(w, events),
                "events": events,
                "_source_path": path,
            })
        return out

    raise ValueError("JSON must be dict or list")


def _looks_like_jsonl(raw: str) -> bool:
    lines = [ln.strip() for ln in raw.splitlines() if ln.strip()]
    if len(lines) < 2:
        return False
    try:
        for ln in lines[:3]:
            json.loads(ln)
        return True
    except json.JSONDecodeError:
        return False
