# TrajRx

**TrajRx** (Trajectory + Rx) is an IDE agent trajectory analysis and efficiency attribution pipeline. It turns Cursor agent transcripts into auditable reports — flattening sessions, building a trajectory IR, checking invariants, and attributing inefficiency.

Two analysis paths:

1. **Rules (default)** — flatten → IR → invariant checker → rule attributor → reconcile
2. **LLM (optional)** — invoke an external agent CLI (`cursor-agent`, `claude`, `codex`) to read artifacts and write `agent-evaluation.md`

## Install (global CLI)

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
trajrx --help   # or: trajrx path/to/transcript.jsonl --run-name demo
```

## Usage

```bash
# Full pipeline → runs/<name>/
trajrx transcript.jsonl --run-name my-analysis

# Flat markdown only
trajrx transcript.jsonl --flatten-only -o session.flat.md

# Batch all .jsonl under a directory
trajrx ~/.cursor/projects --batch

# Resolve by Codex thread title (uses ~/.codex/session_index.jsonl → rollout jsonl)
trajrx --source codex --title "修复 ZYTGXT-131287" --list-sessions
trajrx --source codex --title "修复 ZYTGXT-131287" --run-name ZYTGXT-131287 --agent-eval

# Resolve by Cursor first user message under ~/.cursor/projects/**/agent-transcripts/
trajrx --source cursor --title "ZYTGXT-117563" --list-sessions
trajrx --source cursor --title "ZYTGXT-117563" --run-name cursor-analysis

# Limit Cursor search to one workspace project slug
trajrx --source cursor --cursor-project Users-you-Projects-myrepo --title "fix login bug" --list-sessions

# Codex rollout trace (direct path, auto-detected)
trajrx ~/.codex/sessions/2026/06/15/rollout-*.jsonl --run-name codex-analysis

# Full pipeline + LLM agent evaluation
trajrx --source codex --title "修复 ZYTGXT-131287" --run-name ZYTGXT-131287 --agent-eval

# Verbose stdout (full stage log always saved to runs/<name>/run.log)
trajrx transcript.jsonl --run-name my-analysis --verbose

# Re-run LLM eval on an existing run directory
trajrx runs/my-analysis --agent-eval-only --agent-cli cursor --agent-model auto

# Use Claude Code or Codex CLI instead
trajrx transcript.jsonl --agent-eval --agent-cli claude --agent-model sonnet
trajrx transcript.jsonl --agent-eval --agent-cli codex --agent-model o3
```

### Session index for Harness Console

Build a lightweight Codex/Cursor session index without running the full analysis pipeline:

```bash
trajrx session scan --output ~/.trajrx/session-index.json
trajrx session analyze --changed-only --output ~/.trajrx/session-index.json
```

`--changed-only` preserves cached analysis for unchanged transcript files by comparing mtime and size. Harness Console reads this JSON as a recovery index for active or unfinished Codex/Cursor sessions.

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `TRAJRX_RUNS_DIR` | `~/.trajrx/runs` | Output directory for analysis runs |
| `TRAJRX_HOME` | `~/.trajrx` | Home directory; runs default to `$TRAJRX_HOME/runs` |
| `TRAJRX_AGENT_EVAL` | off | Set `1` to enable `--agent-eval` by default |
| `TRAJRX_AGENT_CLI` | `cursor` | Default agent CLI: `cursor` \| `claude` \| `codex` |
| `TRAJRX_AGENT_MODEL` | profile default | Model flag passed to agent CLI (`auto` for cursor) |
| `TRAJRX_CODEX_HOME` | `~/.codex` | Codex data root for `--source codex --title` lookup |
| `TRAJRX_CURSOR_HOME` | `~/.cursor` | Cursor data root for `--source cursor --title` lookup |
| `TRAJRX_PLAIN=1` | off | Force plain-line stage progress (no listr2 TUI) |

Each run writes `run.log`, `run-summary.md`, and `run-summary.json`. The terminal summary uses [boxen](https://github.com/sindresorhus/boxen) and highlights report paths (`analysis-report.md`, `agent-evaluation.md`).

**Session metrics (Codex):** `analysis-report.md` §2 shows gross session wall time (含用户等待), active wall time (扣除用户等待), and user idle when present. See [docs/reference/metrics.md](./docs/reference/metrics.md).

## Local test fixtures

Transcript fixtures are gitignored (see [test/fixtures/README.md](./test/fixtures/README.md)). Copy your own `.jsonl` into `test/fixtures/` for local runs.

See [PLAN.md](./PLAN.md) for architecture, or the full docs site:

```bash
npm run docs:dev    # local preview at http://localhost:5173
npm run docs:build  # static site → docs/.vitepress/dist
```

### Codex vs Cursor

TrajRx auto-detects transcript format. Codex rollout traces use `event_msg` + `function_call` events (not Cursor's `role`/`tool_use`). Codex-specific invariants include background `write_stdin` polling (`INV-CODEX-001`) and long step gaps (`INV-CODEX-002`).

**Title lookup differs by source:**

| Source | Index | Match field |
|--------|-------|-------------|
| `codex` | `~/.codex/session_index.jsonl` | `thread_name` (UI title) → rollout `sessions/**/rollout-*-{id}.jsonl` |
| `cursor` | `~/.cursor/projects/**/agent-transcripts/` | First user message in each transcript (subagents excluded) |
