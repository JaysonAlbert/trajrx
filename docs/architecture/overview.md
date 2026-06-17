# Architecture Overview

TrajRx is a TypeScript / Node.js ≥20 CLI that analyzes IDE agent session transcripts and produces auditable efficiency attribution reports.

## High-level flow

```
┌─────────────────────────────────────────────────────────────────┐
│                        Input Sources                             │
│  Cursor ~/.cursor/projects/*/agent-transcripts/*.jsonl          │
│  Codex ~/.codex/sessions/**/rollout-*.jsonl                      │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ Stage 0  export/flatten                                        │
│  JSONL → flat Markdown (.flat.md) — readable by humans & LLMs    │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ Stage 1  ir/loader + cursorIr / codexIr                         │
│  Raw events → Trajectory IR (trajectory_id, steps, telemetry)    │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ Stage 2  invariants/presets + checker                           │
│  Preset invariants → auditable violation log                    │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ Stage 3  judge/attributor                                       │
│  Rule aggregation → primary_cause / composite / critical_step │
└────────────────────────────┬────────────────────────────────────┘
                             │
              ┌──────────────┴──────────────┐
              ▼                             ▼
┌──────────────────────────┐   ┌──────────────────────────┐
│ Stage 4  export/reports   │   │ Stage 5  analyst/         │
│  report.md + .flat.md     │   │  reconcile static/manual  │
└──────────────────────────┘   └──────────────────────────┘
                             │
                             ▼ (optional --agent-eval)
┌─────────────────────────────────────────────────────────────────┐
│ Stage 6  eval/runAgentEval + agentCli/                          │
│  eval_context.md → agent CLI (-p) → agent-evaluation.md         │
│  profiles: cursor-agent | claude | codex                        │
└─────────────────────────────────────────────────────────────────┘
```

## Repository layout

```
trajrx/
├── package.json
├── tsconfig.json
├── src/
│   ├── cli.ts              # CLI entry
│   ├── pipeline.ts         # Orchestrates stages 0–5
│   ├── config.ts           # Env & path resolution
│   ├── types/              # Shared types
│   ├── export/             # Flat markdown & analysis reports
│   ├── ir/                 # loader, cursorIr, codexIr, schema
│   ├── invariants/         # presets, checker
│   ├── judge/              # attributor
│   ├── analyst/            # reconcile
│   ├── enrich/             # tool metrics (cursor & codex)
│   ├── agentCli/           # cursor | claude | codex CLI profiles
│   ├── eval/               # LLM agent-evaluation stage
│   ├── session/            # title-based session search
│   └── ui/                 # pipeline TUI & run summary
├── dist/                   # tsc output
├── docs/                   # VitePress documentation
└── runs/                   # analysis artifacts (gitignored)
```

## Module responsibilities

| Module | Responsibility | Uses LLM |
|--------|----------------|----------|
| `export/` | Transcript → flat Markdown | No |
| `ir/` | JSONL → Trajectory IR | No |
| `invariants/` | Deterministic constraint checks | No |
| `judge/` | Violation-weighted attribution | No |
| `analyst/` | Stage heuristics + reconciliation | No |
| `enrich/` | Tool timing, grep patterns, token stats | No |
| `agentCli/` | Pluggable agent CLI invocation | Yes (external) |
| `eval/` | LLM evaluation prompt + artifact write | Yes (external) |

## Design principles

1. **Checker first, judge second** — every attribution claim is backed by auditable invariant violations.
2. **IR unifies heterogeneous sources** — Cursor and Codex transcripts share one schema and one invariant set.
3. **Flat Markdown is AI-oriented** — `#SN` step anchors align with checker `step_index` for downstream LLM consumption.

## Planned extensions

- [x] Codex rollout-trace IR converter
- [x] Agent CLI evaluation path (`--agent-eval` / `--agent-eval-only`)
- [x] Session lookup by title (`--source codex|cursor --title`)
- [x] Terminal UI + run summary
- [x] Session wall time gross/net (Codex; Cursor pending timestamps)
- [ ] Dynamic invariants (LLM-generated per step)
- [ ] Cursor hooks OTel integration
- [ ] npm package / VS Code extension
