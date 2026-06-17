# Pipeline Stages

The pipeline is orchestrated by `src/pipeline.ts`. Each stage writes artifacts under `runs/<name>/`.

```
Raw logs → Flat Markdown → Trajectory IR → Checker → Judge → Report → Reconcile
                                                              ↘ Agent Eval (optional)
```

## Stage 0 — Flatten

**Module:** `src/export/flatten.ts`, `src/export/codexFlatten.ts`

Converts raw JSONL events into a flat Markdown transcript. Format:

- `## User Turn N (#UN)` — user turn
- `## Assistant Step N (#SN, after #UN)` — aligned with IR `step.index`
- `### Tool:` blocks with structured MCP/tool output
- `## Attribution Summary` — appended automatically after judge stage

Flat markdown is the primary input for optional LLM evaluation.

## Stage 1 — Trajectory IR

**Module:** `src/ir/loader.ts`, `src/ir/cursorIr.ts`, `src/ir/codexIr.ts`

Builds a normalized intermediate representation:

- `trajectory_id`
- `steps[]` with `index`, `telemetry` (tool counts, grep patterns, durations)
- `metadata` (user turns, session wall time, tool efficiency snapshot)

**Session metrics (Codex):** `src/ir/sessionMetrics.ts` computes `session_wall_ms`, `user_idle_ms`, and `session_active_wall_ms` during `codexIr()` and stores them on IR metadata. Downstream stages read via `resolveSessionWallMs()` etc. — no Codex-specific logic in reports.

Output: `trajectory_ir.json`

## Stage 2 — Invariant Checker

**Module:** `src/invariants/presets.ts`, `src/invariants/checker.ts`

Runs all preset invariants against the IR. Each violation records:

- `invariant_id`
- `category` (context, tool, mcp, skill)
- `step_index`
- `severity` (low, medium, high)
- `message` and `evidence`

Output: `checker_results/violations.json`, `checker_results/static_invariants.json`

## Stage 3 — Judge / Attributor

**Module:** `src/judge/attributor.ts`

Aggregates violations into session-level attribution:

- `primary_cause`
- `composite` causes
- `critical_step`

Output: `judge_output/attribution.json`

## Stage 4 — Reports

**Module:** `src/export/analysisReport.ts`, `src/export/flatten.ts`

Generates human-readable analysis:

- `reports/<session_id>.md`
- `analysis-report.md`
- `command_breakdown.json`
- `tool_efficiency.json`

## Stage 5 — Reconcile

**Module:** `src/analyst/reconcile.ts`

Cross-checks static rule output against heuristics and optional manual attribution hints.

Output: `reconcile/reconciliation.json`, `reconcile/manual_attribution.json`

## Stage 6 — Agent Evaluation (optional)

**Module:** `src/eval/runAgentEval.ts`, `src/agentCli/`

When `--agent-eval` is set:

1. Builds `eval_context.md` from prior artifacts
2. Invokes external agent CLI with evaluation prompt
3. Writes `agent-evaluation.md` (or `judge_output/attribution.json` merge depending on profile)

Supported CLIs: `cursor-agent`, `claude`, `codex`.

## Enrichment (parallel to IR)

**Module:** `src/enrich/toolMetrics.ts`, `src/enrich/codexToolMetrics.ts`

Computes per-tool and per-session statistics used by invariants and reports — grep pattern repetition, tool wall time, read output size, Codex background sessions, etc.

## UI layer

**Module:** `src/ui/pipelineUi.ts`, `src/ui/runLogger.ts`, `src/ui/summary.ts`

Provides compact TUI progress during pipeline execution and writes `run.log`, `run-summary.md`, `run-summary.json`.

## Session lookup (pre-pipeline)

**Module:** `src/session/search.ts`

Resolves transcript paths by title before Stage 0:

- `--source codex --title` → `~/.codex/session_index.jsonl` + rollout file
- `--source cursor --title` → scan `~/.cursor/projects/**/agent-transcripts/`

Use `--list-sessions` to preview matches without running analysis.
