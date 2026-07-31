# Getting Started

**TrajRx** (Trajectory + Rx) is an IDE agent trajectory analysis and efficiency attribution pipeline. It turns Cursor or Codex agent transcripts into auditable reports — flattening sessions, building a trajectory IR, checking invariants, and attributing inefficiency.

## Requirements

- Node.js ≥ 20
- npm

## Install

### Global CLI

```bash
cd /path/to/trajrx
npm install
npm run build
npm link
```

Or install from a path without link:

```bash
npm install -g /path/to/trajrx
```

Verify:

```bash
trajrx --help
```

### Local development

```bash
npm install
npm run dev -- transcript.jsonl --run-name demo
```

`npm run dev` uses `tsx` and does not require a prior `npm run build`.

## Quick start

Run the full pipeline on a transcript file:

```bash
trajrx transcript.jsonl --run-name my-analysis
```

Output lands in `runs/my-analysis/`. See [Output Artifacts](/architecture/output) for the full file layout. For Codex sessions, `analysis-report.md` §2 includes session wall time (gross vs active); see [Metrics](/reference/metrics).

## Two analysis paths

| Path | Description |
|------|-------------|
| **Rules (default)** | flatten → IR → invariant checker → rule attributor → reconcile |
| **LLM (optional)** | After rules, invoke an external agent CLI to write `agent-evaluation.md` |

Enable LLM evaluation with `--agent-eval` or `TRAJRX_AGENT_EVAL=1`. See [CLI Usage](/guide/cli) for details.

## Local test fixtures

Transcript fixtures are gitignored. Copy your own `.jsonl` into `test/fixtures/` for local runs. See `test/fixtures/README.md` in the repository.

## Documentation site

This project uses [VitePress](https://vitepress.dev/) for documentation under `docs/`:

```bash
npm run docs:dev      # dev server at http://localhost:5173
npm run docs:build    # static output → docs/.vitepress/dist
npm run docs:preview  # preview production build
```
