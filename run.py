#!/usr/bin/env python3
"""Doctor CLI — AgentRx-style IDE agent attribution pipeline."""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime

REPO_ROOT = os.path.dirname(os.path.abspath(__file__))
RUNS_DIR = os.path.join(REPO_ROOT, "runs")

sys.path.insert(0, REPO_ROOT)

from doctor.ir.loader import load_trajectories
from doctor.ir.cursor_ir import cursor_ir
from doctor.ir.schema import is_ir
from doctor.invariants.checker import check_all, write_checker_results
from doctor.judge.attributor import attribute_all
from doctor.reports.aggregator import write_report, write_metrics
from doctor.analyst.phase_analyzer import manual_attribution
from doctor.analyst.reconcile import reconcile, format_reconcile_report
from doctor.export.flatten import flatten_events_to_markdown, append_attribution_section


def banner(msg: str) -> None:
    print(f"\n{'=' * 60}\n  {msg}\n{'=' * 60}")


def ensure_dir(path: str) -> None:
    os.makedirs(path, exist_ok=True)


def run_flatten(input_path: str, run_dir: str, raw_trajectories: list | None = None) -> str:
    banner("Stage 0: Flatten Transcript → Markdown")
    if raw_trajectories is None:
        raw_trajectories = load_trajectories(input_path)
    traj = raw_trajectories[0]
    events = traj.get("events") or []
    tid = traj.get("trajectory_id") or os.path.splitext(os.path.basename(input_path))[0]
    md = flatten_events_to_markdown(
        events,
        trajectory_id=tid,
        source_path=input_path,
    )
    out_path = os.path.join(run_dir, f"{tid}.flat.md")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(md)
    print(f"  Wrote {out_path} ({len(events)} events → flat markdown)")
    return out_path


def run_ir(input_path: str, run_dir: str, raw_trajectories: list | None = None) -> str:
    banner("Stage 1/5: IR Normalization")
    if raw_trajectories is None:
        raw_trajectories = load_trajectories(input_path)
    raw = raw_trajectories
    fmt = raw[0].get("_format") if raw else None
    if fmt == "cursor_jsonl" or input_path.endswith(".jsonl"):
        data = cursor_ir(raw)
    elif is_ir(raw):
        data = raw
    else:
        data = cursor_ir(raw)

    out_path = os.path.join(run_dir, "trajectory_ir.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"  Wrote {out_path} ({len(data)} trajectory/ies, {sum(len(t.get('steps',[])) for t in data)} steps)")
    return out_path


def run_check(ir_path: str, run_dir: str) -> str:
    banner("Stage 2/5: Invariant Checking")
    with open(ir_path, "r", encoding="utf-8") as f:
        trajectories = json.load(f)
    results = check_all(trajectories)
    out_dir = os.path.join(run_dir, "checker_results")
    path = write_checker_results(results, out_dir)
    total_v = sum(r["violation_count"] for r in results)
    print(f"  Wrote {path} ({total_v} violations)")
    return out_dir


def run_judge(ir_path: str, checker_dir: str, run_dir: str) -> str:
    banner("Stage 3/5: Attribution (Judge)")
    with open(ir_path, "r", encoding="utf-8") as f:
        trajectories = json.load(f)
    violations_path = os.path.join(checker_dir, "violations.json")
    with open(violations_path, "r", encoding="utf-8") as f:
        checker_results = json.load(f)
    attributions = attribute_all(checker_results, trajectories)
    out_dir = os.path.join(run_dir, "judge_output")
    ensure_dir(out_dir)
    out_path = os.path.join(out_dir, "attribution.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(attributions, f, ensure_ascii=False, indent=2)
    for a in attributions:
        print(f"  {a['trajectory_id']}: primary_cause={a['primary_cause']} confidence={a['confidence']}")
    return out_path


def run_reconcile(ir_path: str, judge_path: str, run_dir: str) -> str:
    banner("Stage 5/5: Reconciliation (static vs manual)")
    with open(ir_path, "r", encoding="utf-8") as f:
        trajectories = json.load(f)
    with open(judge_path, "r", encoding="utf-8") as f:
        static_attrs = json.load(f)
    static_map = {a["trajectory_id"]: a for a in static_attrs}

    reconciliations = []
    manual_attrs = []
    for traj in trajectories:
        tid = traj["trajectory_id"]
        manual = manual_attribution(traj)
        manual_attrs.append(manual)
        rec = reconcile(static_map[tid], manual)
        reconciliations.append(rec)
        print(f"  {tid}: verdict={rec['verdict']} static={rec['static_primary']} manual={rec['manual_primary']}")

    out_dir = os.path.join(run_dir, "reconcile")
    ensure_dir(out_dir)
    with open(os.path.join(out_dir, "manual_attribution.json"), "w", encoding="utf-8") as f:
        json.dump(manual_attrs, f, ensure_ascii=False, indent=2)
    with open(os.path.join(out_dir, "reconciliation.json"), "w", encoding="utf-8") as f:
        json.dump(reconciliations, f, ensure_ascii=False, indent=2)
    for rec in reconciliations:
        tid = rec["trajectory_id"]
        report = format_reconcile_report(rec)
        with open(os.path.join(out_dir, f"{tid}_reconcile.md"), "w", encoding="utf-8") as f:
            f.write(report)
    return out_dir


def run_report(ir_path: str, checker_dir: str, judge_path: str, run_dir: str, flat_md_path: str | None = None) -> str:
    banner("Stage 4/5: Report")
    with open(ir_path, "r", encoding="utf-8") as f:
        trajectories = json.load(f)
    with open(os.path.join(checker_dir, "violations.json"), "r", encoding="utf-8") as f:
        checker_results = json.load(f)
    with open(judge_path, "r", encoding="utf-8") as f:
        attributions = json.load(f)

    reports_dir = os.path.join(run_dir, "reports")
    ensure_dir(reports_dir)

    cr_map = {r["trajectory_id"]: r for r in checker_results}
    att_map = {a["trajectory_id"]: a for a in attributions}

    for traj in trajectories:
        tid = traj["trajectory_id"]
        report_path = os.path.join(reports_dir, f"{tid}.md")
        write_report(traj, cr_map[tid], att_map[tid], report_path)
        print(f"  Wrote {report_path}")

    metrics_path = os.path.join(reports_dir, "metrics.json")
    write_metrics(attributions, metrics_path)
    print(f"  Wrote {metrics_path}")

    if flat_md_path and os.path.isfile(flat_md_path):
        for traj in trajectories:
            tid = traj["trajectory_id"]
            vlist = cr_map[tid].get("violations") or []
            append_attribution_section(flat_md_path, att_map[tid], vlist)
        print(f"  Appended attribution to {flat_md_path}")

    return reports_dir


def flatten_only(input_path: str, output_path: str | None, run_name: str | None) -> str:
    """Export flat markdown without running attribution pipeline."""
    from doctor.export.flatten import flatten_file
    if run_name:
        run_dir = os.path.join(RUNS_DIR, run_name)
        ensure_dir(run_dir)
        raw = load_trajectories(input_path)
        tid = raw[0].get("trajectory_id") or "transcript"
        out = output_path or os.path.join(run_dir, f"{tid}.flat.md")
        events = raw[0].get("events") or []
        md = flatten_events_to_markdown(events, trajectory_id=tid, source_path=input_path)
        with open(out, "w", encoding="utf-8") as f:
            f.write(md)
        print(f"Wrote {out}")
        return out
    return flatten_file(input_path, output_path)


def process_file(input_path: str, run_name: str | None, skip_judge: bool, flatten_only_flag: bool = False) -> str:
    if flatten_only_flag:
        flatten_only(input_path, None, run_name)
        return ""

    stem = os.path.splitext(os.path.basename(input_path))[0]
    run_name = run_name or f"{stem}_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    run_dir = os.path.join(RUNS_DIR, run_name)
    ensure_dir(run_dir)

    raw = load_trajectories(input_path)
    flat_md_path = run_flatten(input_path, run_dir, raw)
    ir_path = run_ir(input_path, run_dir, raw)
    checker_dir = run_check(ir_path, run_dir)
    if skip_judge:
        print("\n  (--skip-judge: attribution skipped)")
        return run_dir
    judge_path = run_judge(ir_path, checker_dir, run_dir)
    run_report(ir_path, checker_dir, judge_path, run_dir, flat_md_path)
    run_reconcile(ir_path, judge_path, run_dir)
    print(f"\nDone. Output: {run_dir}")
    return run_dir


def main() -> None:
    parser = argparse.ArgumentParser(description="Doctor: IDE agent efficiency attribution")
    parser.add_argument("input", nargs="?", help="Transcript file (.jsonl) or directory for --batch")
    parser.add_argument("--run-name", help="Output run directory name under runs/")
    parser.add_argument("--batch", action="store_true", help="Process all .jsonl in input directory")
    parser.add_argument("--stage", choices=["ir", "check", "judge", "report", "all"], default="all")
    parser.add_argument("--run-dir", help="Existing run dir (for partial stages)")
    parser.add_argument("--flatten-only", action="store_true", help="Only export flat markdown, skip attribution")
    parser.add_argument("-o", "--output", help="Output path for --flatten-only")
    parser.add_argument("--skip-judge", action="store_true", help="Skip judge and report")
    args = parser.parse_args()

    if not args.input:
        parser.print_help()
        sys.exit(1)

    if args.flatten_only:
        flatten_only(args.input, args.output, args.run_name)
        return

    if args.batch:
        if not os.path.isdir(args.input):
            print(f"Not a directory: {args.input}")
            sys.exit(1)
        for root, _, files in os.walk(args.input):
            for fn in sorted(files):
                if fn.endswith(".jsonl"):
                    path = os.path.join(root, fn)
                    print(f"\n>>> Processing {path}")
                    process_file(path, None, args.skip_judge, False)
        return

    process_file(args.input, args.run_name, args.skip_judge, False)


if __name__ == "__main__":
    main()
