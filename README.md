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
trajrx --help   # or: trajrx test/fixtures/qis-strategy-index-analysis.jsonl --run-name demo
```

## Usage

```bash
# Full pipeline → runs/<name>/
trajrx transcript.jsonl --run-name my-analysis

# Flat markdown only
trajrx transcript.jsonl --flatten-only -o session.flat.md

# Batch all .jsonl under a directory
trajrx ~/.cursor/projects --batch

# Codex rollout trace (auto-detected)
trajrx ~/.codex/sessions/2026/06/15/rollout-*.jsonl --run-name codex-analysis

# Full pipeline + LLM agent evaluation (cursor-agent --mode ask --model auto -p)
trajrx transcript.jsonl --run-name my-analysis --agent-eval

# Re-run LLM eval on an existing run directory
trajrx runs/my-analysis --agent-eval-only --agent-cli cursor --agent-model auto

# Use Claude Code or Codex CLI instead
trajrx transcript.jsonl --agent-eval --agent-cli claude --agent-model sonnet
trajrx transcript.jsonl --agent-eval --agent-cli codex --agent-model o3
```

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `TRAJRX_RUNS_DIR` | `./runs` (cwd) | Output directory for analysis runs |
| `TRAJRX_HOME` | `~/.trajrx` | Optional home for runs when set |
| `TRAJRX_AGENT_EVAL` | off | Set `1` to enable `--agent-eval` by default |
| `TRAJRX_AGENT_CLI` | `cursor` | Default agent CLI: `cursor` \| `claude` \| `codex` |
| `TRAJRX_AGENT_MODEL` | profile default | Model flag passed to agent CLI (`auto` for cursor) |

## Test fixture

```bash
npm run analyze -- test/fixtures/qis-strategy-index-analysis.jsonl --run-name qis-fixture
```

See [PLAN.md](./PLAN.md) for architecture.

### Codex vs Cursor

TrajRx auto-detects transcript format. Codex rollout traces use `event_msg` + `function_call` events (not Cursor's `role`/`tool_use`). Codex-specific invariants include background `write_stdin` polling (`INV-CODEX-001`) and long step gaps (`INV-CODEX-002`).
