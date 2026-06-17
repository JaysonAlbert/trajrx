# Invariants

TrajRx ships with preset invariants in `src/invariants/presets.ts`. Each invariant is a pure function over Trajectory IR that returns zero or more `Violation` records.

Violations are aggregated by `src/judge/attributor.ts` into session-level attribution.

## Categories

| Category | Focus |
|----------|-------|
| `context` | Session-level patterns — read volume, step ratio, scope creep |
| `tool` | Tool usage — repeated grep/shell, slow calls, output bloat |
| `mcp` | MCP tool overuse and thrashing |
| `skill` | Agent skill discovery vs. harness usage |

## Context invariants

| ID | Description | Threshold (summary) |
|----|-------------|---------------------|
| `INV-CTX-001` | Too many tools per step | > 8 tool calls in one step |
| `INV-CTX-002` | Excessive Read ops | > 40 Read operations per session |
| `INV-CTX-003` | High assistant/user ratio | > 12 steps per user turn |
| `INV-CTX-004` | Scope creep low delivery | ≥ 20 user turns but < 15 write/edit ops |

## Tool invariants

| ID | Description |
|----|-------------|
| `INV-TOOL-001` | Repeated Grep — same pattern ≥ 3 times |
| `INV-TOOL-002` | Repeated Shell — same command ≥ 3 times |
| `INV-TOOL-003` | Harness retry loop |
| `INV-TOOL-004` | Slow single tool execution |
| `INV-TOOL-005` | Bloated tool output |
| `INV-TOOL-006` | Excessive total tool wall time |
| `INV-TOOL-007` | Read output bloat |
| `INV-TOOL-008` | Bloated tool input parameters — Shell flags/env or JSON field count |
| `INV-TOOL-009` | Large tool output (10k–50k tokens) |

## MCP invariants

| ID | Description |
|----|-------------|
| `INV-MCP-001` | MCP-heavy session |
| `INV-MCP-002` | MCP thrashing |

## Skill invariants

| ID | Description |
|----|-------------|
| `INV-SKILL-001` | Skill read but over-explore |
| `INV-SKILL-002` | Missing harness skill |

## Codex-specific invariants

Applied when transcript format is `codex_rollout`:

| ID | Category | Description |
|----|----------|-------------|
| `INV-CODEX-001` | tool | Background exec polling (`write_stdin` loops) |
| `INV-CODEX-002` | context | Long thinking gap between steps |
| `INV-CODEX-003` | context | Discovery before bootstrap |

## Violation shape

```typescript
interface Violation {
  invariant_id: string;
  category: "context" | "tool" | "mcp" | "skill";
  step_index: number;
  severity: "low" | "medium" | "high";
  message: string;
  evidence: Record<string, unknown>;
}
```

## Severity weighting

The attributor weights violations by severity when computing `primary_cause` and `critical_step`. High-severity context violations (e.g. excessive reads, scope creep) typically dominate session-level attribution.

See `checker_results/static_invariants.json` in any run directory for the exact definitions used in that analysis.
