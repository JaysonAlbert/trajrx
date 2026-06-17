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

These fields are written during IR normalization and read via `src/ir/sessionMetrics.ts` (`resolveSessionWallMs`, `resolveUserIdleMs`, `resolveSessionActiveWallMs`) so reports, checker telemetry, and terminal summary stay source-agnostic.

### Source support

| Source | Gross wall time | Net (active) wall time | User idle |
|--------|-----------------|------------------------|-----------|
| **Codex** | ✅ from rollout event timestamps | ✅ computed | ✅ computed when idle > 0 |
| **Cursor** | ❌ not yet (transcript has no per-event timestamps) | ❌ | ❌ |

For Cursor sessions, `analysis-report.md` section 2 omits wall-time rows until timestamps are available (e.g. Cursor hooks OTel).

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
| `src/ir/sessionMetrics.ts` | Wall/idle computation (Codex) and resolve helpers |
| `src/ir/codexIr.ts` | Writes session metadata into IR |
| `src/export/analysisReport.ts` | Section 2 会话指标 table |
| `src/invariants/checker.ts` | Includes wall metrics in `telemetry_summary` |
| `src/ui/summary.ts` | Terminal and `run-summary.*` output |
