# Codex vs Cursor

TrajRx auto-detects transcript format from JSONL content. Codex rollout traces use `event_msg` + `function_call` events; Cursor transcripts use `role` / `tool_use` structure.

## Title lookup

| Source | Index location | Match field |
|--------|----------------|-------------|
| `codex` | `~/.codex/session_index.jsonl` | `thread_name` (UI title) → rollout `sessions/**/rollout-*-{id}.jsonl` |
| `cursor` | `~/.cursor/projects/**/agent-transcripts/` | First user message in each transcript (subagents excluded) |

Use `--list-sessions` to preview matches before running analysis:

```bash
trajrx --source codex --title "修复 ZYTGXT-131287" --list-sessions
trajrx --source cursor --title "ZYTGXT-117563" --list-sessions
```

## Format detection

The pipeline calls `detectTranscriptFormat()` on raw events and routes to the appropriate IR builder:

- **Cursor** → `src/ir/cursorIr.ts`
- **Codex** → `src/ir/codexParser.ts` + `src/ir/codexIr.ts`

Both produce the same Trajectory IR schema so invariants and attribution run unchanged.

## Codex-specific behavior

Codex sessions include background `write_stdin` polling and longer thinking gaps. Additional invariants apply:

| ID | Category | Description |
|----|----------|-------------|
| `INV-CODEX-001` | tool | Background exec polling |
| `INV-CODEX-002` | context | Long thinking gap between steps |
| `INV-CODEX-003` | context | Discovery before bootstrap |

Codex enrichment (`src/enrich/codexToolMetrics.ts`) tracks background sessions, thinking gaps, and token usage separately from Cursor tool metrics.

## Cursor project scoping

When many workspaces are indexed, narrow Cursor search:

```bash
trajrx --source cursor --cursor-project Users-you-Projects-myrepo --title "fix login bug"
```

The project slug matches the directory name under `~/.cursor/projects/`.
