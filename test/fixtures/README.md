# Test fixtures

## `qis-strategy-index-analysis.jsonl`

Cursor agent session used to validate the TrajRx pipeline end-to-end.

| Field | Value |
|-------|-------|
| Session ID | `c129aee9-314f-4af2-88b2-b1a2a165eca8` |
| Task | QIS 策略指数文件结构分析 + harness 跑 QIS + fixtures |
| User turns | 26 |
| Assistant steps | ~320 |
| Source project | libra-server |

### Run against fixture

```bash
npm run build
npm run analyze -- test/fixtures/qis-strategy-index-analysis.jsonl --run-name qis-fixture
# or after global install:
trajrx test/fixtures/qis-strategy-index-analysis.jsonl --run-name qis-fixture
```

Expected: `primary_cause=tool` (or compound tool+context), `critical_step=20`, 11 violations.

## `codex-autocall-fee-bootstrap.jsonl`

Codex rollout trace (truncated) for ZYTGXT-117563 harness bootstrap session.

| Field | Value |
|-------|-------|
| Task | 启动 Autocall 费用字段联调环境（Docker + 前端 worktree） |
| Source | Codex `rollout-2026-06-15T11-03-56-*.jsonl` (first ~220 events) |

```bash
npm run analyze -- test/fixtures/codex-autocall-fee-bootstrap.jsonl --run-name codex-fixture
```

Expected: `primary_cause=compound`, violations include `INV-CODEX-001` (background pnpm poll) and `INV-CODEX-002` (umi --version gap).
