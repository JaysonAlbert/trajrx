"""Trajectory IR schema and validation."""

from __future__ import annotations

from typing import Any


def validate_ir(ir: dict[str, Any]) -> None:
    if not isinstance(ir, dict):
        raise ValueError("IR must be a dict")
    for key in ("trajectory_id", "instruction", "steps"):
        if key not in ir:
            raise ValueError(f"IR missing key: {key}")
    if not isinstance(ir["steps"], list):
        raise ValueError("IR.steps must be a list")
    for step in ir["steps"]:
        if not isinstance(step, dict):
            raise ValueError("Each step must be a dict")
        if "index" not in step:
            raise ValueError("Step missing index")
        subs = step.get("substeps", [])
        if not isinstance(subs, list):
            raise ValueError("Step.substeps must be a list")
        for sub in subs:
            for k in ("sub_index", "role", "content"):
                if k not in sub:
                    raise ValueError(f"Substep missing {k}")


def is_ir(data: list[dict[str, Any]]) -> bool:
    if not data:
        return False
    try:
        validate_ir(data[0])
        return True
    except (ValueError, TypeError, KeyError):
        return False
