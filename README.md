# cursor-agent-doctor

IDE agent efficiency attribution pipeline (AgentRx-style). Flattens Cursor JSONL transcripts to readable Markdown, runs deterministic invariant checks, and attributes inefficiency to **context / tool / MCP / skill**.

## Install (global CLI)

```bash
cd /path/to/doctor
npm install
npm run build
npm link
```

Or install from a path without link:

```bash
npm install -g /path/to/doctor
```

Verify:

```bash
doctor --help   # or: doctor test/fixtures/qis-strategy-index-analysis.jsonl --run-name demo
```

## Usage

```bash
# Full pipeline → runs/<name>/
doctor transcript.jsonl --run-name my-analysis

# Flat markdown only
doctor transcript.jsonl --flatten-only -o session.flat.md

# Batch all .jsonl under a directory
doctor ~/.cursor/projects --batch
```

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `DOCTOR_RUNS_DIR` | `./runs` (cwd) | Output directory for analysis runs |
| `DOCTOR_HOME` | `~/.doctor` | Optional home for runs when set |

## Test fixture

```bash
npm run analyze -- test/fixtures/qis-strategy-index-analysis.jsonl --run-name qis-fixture
```

See [PLAN.md](./PLAN.md) for architecture.
