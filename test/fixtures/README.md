# Test fixtures (local only)

Transcript fixtures are **not committed** to the repository. They may contain local paths, internal hostnames, or other sensitive session data.

Place your own `.jsonl` files in this directory for local testing:

```bash
# Example: copy a Cursor agent transcript
cp ~/.cursor/projects/<project>/agent-transcripts/<session>.jsonl \
  test/fixtures/my-session.jsonl

npm run build
npm run analyze -- test/fixtures/my-session.jsonl --run-name local-test
```

## Suggested local smoke tests

| File (local) | Format | Notes |
|--------------|--------|-------|
| `my-cursor-session.jsonl` | Cursor agent transcript | Multi-turn session with tool calls |
| `my-codex-rollout.jsonl` | Codex rollout trace | `event_msg` + `function_call` events |

Before sharing transcripts externally, redact absolute paths, credentials, and internal infrastructure details.
