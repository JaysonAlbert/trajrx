# Test fixtures

## `qis-strategy-index-analysis.jsonl`

Cursor agent session used to validate the doctor pipeline end-to-end.

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
doctor test/fixtures/qis-strategy-index-analysis.jsonl --run-name qis-fixture
```

Expected: `primary_cause=tool` (or compound tool+context), `critical_step=20`, 11 violations.
