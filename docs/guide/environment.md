# Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `TRAJRX_RUNS_DIR` | `~/.trajrx/runs` | Output directory for analysis runs |
| `TRAJRX_HOME` | `~/.trajrx` | Home directory; runs default to `$TRAJRX_HOME/runs` |
| `TRAJRX_AGENT_EVAL` | off | Set `1` / `true` / `yes` to enable `--agent-eval` by default |
| `TRAJRX_AGENT_CLI` | `cursor` | Default agent CLI: `cursor` \| `claude` \| `codex` |
| `TRAJRX_AGENT_MODEL` | profile default | Model flag passed to agent CLI (`auto` for cursor) |
| `TRAJRX_CODEX_HOME` | `~/.codex` | Codex data root for `--source codex --title` lookup |
| `TRAJRX_CURSOR_HOME` | `~/.cursor` | Cursor data root for `--source cursor --title` lookup |
| `TRAJRX_PLAIN` | off | Set `1` to disable TUI and use plain-line progress output |

## Run output

Each run writes:

- `run.log` — full stage log
- `run-summary.md` — human-readable summary
- `run-summary.json` — machine-readable summary

All under `runs/<name>/` (or your configured `TRAJRX_RUNS_DIR`).

## Resolution order for runs directory

1. `TRAJRX_RUNS_DIR` if set
2. `$TRAJRX_HOME/runs` (default: `~/.trajrx/runs`)
