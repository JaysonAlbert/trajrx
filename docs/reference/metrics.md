# Session & Tool Metrics

TrajRx computes several time and token metrics. They appear in `analysis-report.md`, `run-summary.md`, `checker_results` telemetry, and `trajectory_ir.json` metadata.

## Session wall time

Two complementary session-level metrics help compare **calendar span** vs **active agent time**:

| Metric (report label) | IR field | Meaning |
|-----------------------|----------|---------|
| 会话墙时（含用户等待） | `metadata.session_wall_ms` | First → last transcript event timestamp (gross span) |
| 会话活跃墙时（扣除用户等待） | `metadata.session_active_wall_ms` | Gross minus user idle between turns |
| 用户等待时间 | `metadata.user_idle_ms` | Sum of gaps: previous turn last activity → next user message |

**Idle definition (Codex):** For each user turn after the first, idle = timestamp of next `user_message` minus the latest timestamp among the previous turn's steps and tool calls.

**Active wall time:** `session_active_wall_ms = session_wall_ms - user_idle_ms` (floored at 0).

User idle describes calendar chronology, not Agent inefficiency. It must not affect
an efficiency grade. Codex "thinking gap" diagnostics compare only consecutive
Assistant steps inside the same user turn, so overnight or delayed user replies are
not mislabeled as model/tool waiting.

These fields are written during IR normalization and read via `src/ir/sessionMetrics.ts` (`resolveSessionWallMs`, `resolveUserIdleMs`, `resolveSessionActiveWallMs`) so reports, checker telemetry, and terminal summary stay source-agnostic.

### Source support

| Source | Gross wall time | Net (active) wall time | User idle |
|--------|-----------------|------------------------|-----------|
| **Codex** | ✅ from rollout event timestamps | ✅ computed | ✅ computed when idle > 0 |
| **Cursor** | ✅ from transcript file birthtime → mtime | ✅ gross − idle (idle often 0) | ⚠️ estimated via terminal timestamp gaps when available |

For Cursor sessions without per-event timestamps, gross wall time uses the transcript file's birthtime and mtime. User idle is estimated from gaps between matched terminal `started_at` / `ended_at` across user turns when project `terminals/*.txt` metadata exists; otherwise idle is 0 and net equals gross.

IR metadata records provenance: `metadata.session.wall_source` (`event_timestamps` | `file_mtime`) and `metadata.session.idle_source` (`turn_gaps` | `terminal_gaps` | `unavailable`).

## Tool wall time

| Metric (report label) | Meaning |
|-----------------------|---------|
| 工具总墙时 | Sum of per-tool `duration_ms` across all steps |

**Codex:** Parsed from tool output (`Wall time: N seconds`), `yield_time_ms` for background polls, or aggregated background exec sessions (`src/enrich/codexToolMetrics.ts`).

**Cursor:** Matched from project `terminals/*.txt` metadata and `agent-tools/*.txt` output sizes (`src/enrich/toolMetrics.ts`).

Tool wall time is **not** the same as session wall time — it excludes thinking gaps, user idle, and time between tool calls without a measured duration.

## Other session metrics

| Metric | Location | Meaning |
|--------|----------|---------|
| 用户轮次 | IR `metadata.user_turns` | User message count |
| Assistant 步骤 | IR `metadata.step_count` | Assistant steps with substeps |
| 步数比 | Report | `step_count / user_turns` |
| 工具输出 tokens | Checker telemetry | Estimated or parsed output token sum |
| 工具传参（最大/均） | `analysis-report.md` §2 | Per-call input param count (Shell flags/env; JSON keys for structured tools) |
| 高传参 / 高输出调用 | Checker telemetry | Calls with ≥8 params or ≥10k output tokens |

`total_shell_calls`, `total_read_calls`, and `total_grep_calls` count mutually
exclusive observed tool categories, matching `tool_breakdown`. Separate command and
pattern arrays may still record embedded operations (for example `docker logs | rg`)
for repetition diagnostics without inflating invocation counts.

## Session-index selection features

`trajrx session analyze` projects a versioned `cheap_features` object into each
session-index entry. It is intended for inexpensive, deterministic candidate
selection before any Agent evaluation and includes:

- gross and active wall time, user turns, Assistant steps, tool calls, tool
  output tokens, and transcript bytes;
- resume, context-compaction, and subagent-spawn counts when the source exposes
  them reliably;
- explicit error counts plus exact repeated-tool signatures used as retry and
  loop signals.

`extraction_status` is `complete`, `partial`, or `unavailable`. Unsupported or
unobservable metrics are `null` and listed in `unavailable`; zero means the
extractor observed the metric and found no occurrences. The retry/loop fields
are selection signals rather than causal diagnoses: Harness should combine
them with configurable thresholds and persist the reason for each decision.

## Tool input parameters

TrajRx estimates how many parameters each tool invocation passes, to surface CLI ergonomics issues (e.g. long `harness test run` command lines).

| Tool type | Counting rule |
|-----------|---------------|
| **Shell** | `--long-flags`, short `-x` flags, Maven `-Dprop=`, and `ENV_VAR=` assignments |
| **Structured tools** | Non-empty keys in `tool_input` JSON (excluding `_`-prefixed internal fields) |

Report thresholds for optimization candidates (`src/enrich/toolInputMetrics.ts`):

| Signal | Medium | High |
|--------|--------|------|
| Param count | ≥ 8 | ≥ 12 |
| Input chars | ≥ 600 | ≥ 1200 |
| Output tokens | ≥ 10,000 | ≥ 50,000 |

`analysis-report.md` §4 lists optimization candidates; §4 传参 Top 15 ranks aggregated commands by param count.

Related invariants: `INV-TOOL-008` (input bloat), `INV-TOOL-005` / `INV-TOOL-009` (output bloat tiers).

## Tool output tokens
| TrajRx run duration | `run-summary` | Wall time of the TrajRx pipeline itself, not the agent session |

## Terminal summary

After a run, the boxen summary shows:

- `session (gross)` — seconds from `session_wall_ms`
- `session (net)` — seconds from `session_active_wall_ms`
- `tool time` — seconds from enrichment aggregate

User idle appears in `run-summary.md` only when `user_idle_sec > 0`.

## Related modules

| Module | Role |
|--------|------|
| `src/ir/sessionMetrics.ts` | Wall/idle computation and resolve helpers |
| `src/ir/adapters/` | `TranscriptAdapter` — enrich, flatten, IR per source |
| `src/ir/stepTelemetry.ts` | Shared per-step telemetry aggregation |
| `src/ir/codexIr.ts` | Writes session metadata into IR |
| `src/export/analysisReport.ts` | Section 2 会话指标 table |
| `src/invariants/checker.ts` | Includes wall metrics in `telemetry_summary` |
| `src/ui/summary.ts` | Terminal and `run-summary.*` output |
