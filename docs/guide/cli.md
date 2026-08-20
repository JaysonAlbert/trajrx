# CLI Usage

## Basic commands

```bash
# Full pipeline → runs/<name>/
trajrx transcript.jsonl --run-name my-analysis

# Flat markdown only
trajrx transcript.jsonl --flatten-only -o session.flat.md

# Batch all .jsonl under a directory
trajrx ~/.cursor/projects --batch

# Verbose stdout (full stage log always saved to runs/<name>/run.log)
trajrx transcript.jsonl --run-name my-analysis --verbose
```

## Session lookup by title

### Codex

Uses `~/.codex/session_index.jsonl` (`thread_name`) → rollout `sessions/**/rollout-*-{id}.jsonl`.

```bash
trajrx --source codex --title "修复 ZYTGXT-131287" --list-sessions
trajrx --source codex --title "修复 ZYTGXT-131287" --run-name ZYTGXT-131287 --agent-eval
```

### Cursor

Searches `~/.cursor/projects/**/agent-transcripts/` and matches the first user message (subagents excluded).

```bash
trajrx --source cursor --title "ZYTGXT-117563" --list-sessions
trajrx --source cursor --title "ZYTGXT-117563" --run-name cursor-analysis
```

Limit search to one workspace project slug:

```bash
trajrx --source cursor --cursor-project Users-you-Projects-myrepo --title "fix login bug" --list-sessions
```

## Direct file paths

```bash
# Codex rollout trace (auto-detected format)
trajrx ~/.codex/sessions/2026/06/15/rollout-*.jsonl --run-name codex-analysis
```

## Re-run stages on existing runs

```bash
# Regenerate analysis report from existing run artifacts
trajrx runs/my-analysis --analysis-only

# Re-run LLM eval on an existing run directory
trajrx runs/my-analysis --agent-eval-only --agent-cli cursor --agent-model auto
```

## Subagent efficiency evidence

Use the lightweight subcommand when a workflow or Hook needs deterministic
subagent timing without running the full attribution pipeline:

```bash
trajrx subagents /path/to/rollout.jsonl --json
trajrx subagents /path/to/rollout.jsonl \
  --from 2026-08-20T01:17:49.930Z \
  --to 2026-08-20T01:56:21.931Z \
  --json
```

`--from` and `--to` are required together. The time window clips overlapping
activation and parent-wait intervals, which lets a Hook analyze only the turn
that triggered it. See [Subagent efficiency evidence](/architecture/subagent-efficiency).

## Hook-scoped turn analysis

Use the lightweight turn command when a Hook or workflow needs deterministic
evidence for exactly one completed turn without running the attribution or LLM
pipeline:

```bash
# Codex: Hook state carries the exact conversation and turn identity
trajrx turn analyze \
  --client codex \
  --hook-state /path/to/long-task-retro/v1/2026-08-20/identity-hash \
  --json

# Cursor: Hook state binds the conversation, generation, and wall-clock interval
trajrx turn analyze \
  --client cursor \
  --hook-state /path/to/long-task-retro/v1/2026-08-20/identity-hash \
  --json
```

Pass `--session` only when the caller already has the exact transcript path or
bounded discovery is ambiguous. `--top N` bounds detail lists while preserving
aggregate totals. Selection and timestamp inconsistencies fail non-zero instead
of falling back to a latest turn. See [Canonical turn analysis](/architecture/turn-analysis)
for the `trajrx_turn_analysis_v1` contract and source-specific availability.

## Agent evaluation (LLM path)

```bash
# Full pipeline + LLM agent evaluation
trajrx --source codex --title "修复 ZYTGXT-131287" --run-name ZYTGXT-131287 --agent-eval

# Use Claude Code or Codex CLI instead
trajrx transcript.jsonl --agent-eval --agent-cli claude --agent-model sonnet
trajrx transcript.jsonl --agent-eval --agent-cli codex --agent-model o3
```

### Agent CLI options

| Flag | Values | Default |
|------|--------|---------|
| `--agent-eval` | — | off (unless `TRAJRX_AGENT_EVAL=1`) |
| `--skip-agent-eval` | — | disable even if env is set |
| `--agent-eval-only` | — | re-run LLM eval on existing run dir |
| `--agent-cli` | `cursor` \| `claude` \| `codex` | `cursor` |
| `--agent-model` | profile-specific | profile default (`auto` for cursor) |

Supported external CLIs: `cursor-agent`, `claude`, `codex`.

## All flags

```
trajrx <transcript.jsonl> [--run-name NAME] [--agent-eval]
trajrx --source codex|cursor --title "会话标题" [--run-name NAME] [--agent-eval]
trajrx --source codex|cursor --title "会话标题" --list-sessions
trajrx turn analyze --client codex --hook-state PATH [--session PATH] [--top N] [--json]
trajrx turn analyze --client cursor --hook-state PATH [--session PATH] [--top N] [--json]
trajrx subagents <transcript.jsonl> [--from ISO --to ISO] [--json]
trajrx <transcript.jsonl> --flatten-only [-o out.md]
trajrx <run-dir> --analysis-only
trajrx <run-dir> --agent-eval-only [--agent-cli cursor|claude|codex] [--agent-model MODEL]
trajrx <dir> --batch [--agent-eval]
```

| Flag | Description |
|------|-------------|
| `--run-name` | Output subdirectory under `runs/` |
| `--flatten-only` | Export flat markdown only |
| `-o` / `--output` | Output path for flatten-only mode |
| `--batch` | Process all `.jsonl` files under a directory |
| `--skip-judge` | Skip judge/attribution stage |
| `--analysis-only` | Regenerate analysis from existing run |
| `--verbose` | Mirror stage details to stdout |
| `--list-sessions` | Print matching sessions and exit |
| `--from` / `--to` | Inclusive ISO-8601 window for `subagents` evidence; both required |
| `--client` | Transcript source for `turn analyze`: `codex` or `cursor` |
| `--hook-state` | Exact Hook state directory or state JSON path; required for turn analysis |
| `--session` | Exact transcript path for turn analysis |
| `--top` | Positive bound for each turn-analysis detail list (default 10) |
| `--json` | Print complete machine-readable evidence |

Terminal output uses compact per-stage progress. Set `TRAJRX_PLAIN=1` to force plain-line mode without TUI.
