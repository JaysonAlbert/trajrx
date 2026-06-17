# Output Artifacts

Each analysis run creates a directory under `runs/<name>/` (configurable via `TRAJRX_RUNS_DIR`).

## Directory layout

```
runs/<name>/
├── run.log                          # Full stage log
├── run-summary.md                   # Human-readable run summary
├── run-summary.json                 # Machine-readable run summary
├── <session_id>.flat.md             # Flat markdown transcript
├── trajectory_ir.json               # Normalized trajectory IR
├── checker_results/
│   ├── violations.json              # All invariant violations
│   └── static_invariants.json       # Invariant definitions snapshot
├── judge_output/
│   └── attribution.json             # Rule-based attribution
├── reports/
│   ├── <session_id>.md              # Per-session report
│   └── metrics.json                 # Session metrics
├── analysis-report.md               # Consolidated analysis
├── command_breakdown.json           # Shell/command usage breakdown
├── tool_efficiency.json             # Tool timing & efficiency stats
├── reconcile/
│   ├── reconciliation.json          # Reconcile output
│   └── manual_attribution.json        # Manual attribution hints
└── eval_context.md                  # (with --agent-eval) LLM eval input
    agent-evaluation.md              # (with --agent-eval) LLM eval output
```

Exact files depend on pipeline flags and transcript format.

## Key artifacts

### `trajectory_ir.json`

Normalized session representation shared by checker, judge, and reports. Contains `steps[]` with telemetry used by all invariant checks.

### `checker_results/violations.json`

Array of violations. Each entry links an `invariant_id` to a `step_index` with severity and evidence — the auditable foundation for attribution.

### `judge_output/attribution.json`

Session-level efficiency attribution derived from violation weights:

```json
{
  "primary_cause": "...",
  "composite": ["..."],
  "critical_step": 42
}
```

### `*.flat.md`

AI-readable session transcript. Step anchors (`#SN`) match `step_index` in violations for cross-referencing.

### `run-summary.md` / `run-summary.json`

Compact post-run summary: stages completed, violation counts, primary cause, token/tool stats.

## Re-running without full pipeline

```bash
# Regenerate reports from existing IR + violations + attribution
trajrx runs/my-analysis --analysis-only

# Re-run only LLM evaluation
trajrx runs/my-analysis --agent-eval-only --agent-cli cursor
```

These modes reuse artifacts already on disk and only execute downstream stages.
