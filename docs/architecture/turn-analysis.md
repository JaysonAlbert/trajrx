# Canonical turn analysis

TrajRx owns deterministic transcript parsing and efficiency evidence for a
single completed Agent turn. A consumer such as Harness `agent-retro` owns the
semantic judgment that follows. Consumers must not keep a second transcript
parser or reinterpret raw timestamps when this contract is available.

## Command boundary

The stable machine entry point is:

```bash
trajrx turn analyze \
  --client codex \
  --hook-state /path/to/long-task-retro/v1/<date>/<identity-hash> \
  --json
```

`--hook-state` is mandatory for both clients. TrajRx reads the immutable
`start.json` and `request.json`, verifies their client/conversation/turn binding,
and never accepts the acknowledgement secret. `--session` may provide an exact
rollout path; otherwise Codex searches only the current and preceding UTC date
directories below `${TRAJRX_CODEX_HOME:-~/.codex}/sessions`, requires one rollout
for the Hook conversation ID, and never scans older history. `--codex-home`
overrides the default root.

Cursor uses Hook state to bind the exact generation and resolve the main
conversation transcript:

```bash
trajrx turn analyze \
  --client cursor \
  --hook-state /path/to/long-task-retro/v1/<date>/<identity-hash> \
  --json
```

`--session` may disambiguate Cursor resolution and `--cursor-home` may override
the default `~/.cursor`. `--top` is a positive integer that bounds every detail
list; aggregates are always calculated before bounding. The command never runs
the rule judge, attribution pipeline, or Agent evaluation.

## Fail-closed selection

### Codex

Hook `start.json` and `request.json` must agree on `client=codex`, conversation
ID and turn ID. The selected rollout must declare that conversation ID in
`session_meta` and contain exactly one matching `task_started`. Repeated
`turn_context` records caused by compaction or resume are permitted. Missing,
duplicate, malformed or unresolved
identities fail non-zero. There is no latest-Hook fallback. In particular, the
Codex-provided `hook_run_id` text identifies a Hook definition and can repeat;
it is not used as a per-invocation selector.

The target turn begins at the first user message after the matching
`task_started` and ends at the last assistant final whose observed time is at or
before `request.json.requestedWallNs`. This request-time cutoff is what excludes
the Hook continuation: Codex may keep that continuation under the same turn ID
and emit `task_complete` only after the retrospective. Additional user steering
before the selected final stays in the triggering turn. Earlier turns and the
active Hook follow-up are excluded.

Selection compares against the numeric `requestedWallNs` value without first
rounding it through an ISO millisecond string. ISO rendering is presentation
only; sub-millisecond finals immediately before the request remain eligible.

When `--session` is omitted, discovery examines only `.jsonl` files below the
current and previous UTC date directories. Candidate filenames are matched by
the exact Hook conversation ID and the selected file is validated against
`session_meta`; no match or more than one match is actionable failure. The
recovery message asks the caller to pass `--session` when bounded discovery
cannot identify one rollout.

### Cursor

`start.json` and `request.json` must agree on client, conversation/generation
identity and contain a monotonic generation wall-clock interval. TrajRx resolves
only the main
`agent-transcripts/<conversationId>/<conversationId>.jsonl`; subagent transcripts
are never selected as the parent turn.

Reverse acquisition starts with 2 MiB and doubles up to a fixed 16 MiB cap. A
target turn is complete only after the reader observes its successful
`turn_ended` record and the nearest preceding `turn_ended` boundary of any
status, or beginning of file. An intervening failed or aborted turn therefore
cannot be mixed into the next successful target. If the cap is reached first,
the command fails non-zero and does not emit partial evidence. Malformed rows
inside the selected window also fail.

## Normative JSON contract

The command emits the following additive v1 shape. `T | null` means the source
may not support the metric. Every unsupported field is also named by its exact
JSON path in `unavailable`; an observed zero is never listed as unavailable.
For bounded-list item fields, `items[*]` is the canonical wildcard segment and
applies to every returned item. Source-discriminated `selection` nulls are not
availability failures, and `subagent_efficiency` validates availability through
its own versioned nested contract.

```ts
interface TrajRxTurnAnalysisV1 {
  schema: "trajrx_turn_analysis_v1";
  schema_version: 1;
  source: "codex" | "cursor";
  selection: {
    mode: "codex_hook_turn" | "cursor_hook_generation";
    request_id: string;
    requested_at: string;
    conversation_id: string | null;
    turn_id: string | null;
    generation_id: string | null;
    hook_state_path: string;
    session_path: string;
  };
  boundary: {
    started_at: string;
    ended_at: string;
    start_time_source: "internal_create_time" | "outer_timestamp" | "hook_state_wall_clock";
    end_time_source: "internal_create_time" | "outer_timestamp" | "hook_state_wall_clock";
    user_preview: string;
    final_preview: string;
  };
  elapsed: {
    total_ms: number;
    tool_wait_union_ms: number | null;
    tool_wait_sum_ms: number | null;
    other_observed_ms: number | null;
  };
  tools: {
    call_count: number;
    failed_count: number | null;
    incomplete_count: number | null;
    total_input_chars: number;
    total_param_count: number;
    total_output_chars: number | null;
    total_output_tokens: number | null;
    longest_calls: BoundedList<ToolCallEvidence> | null;
    failed_calls: BoundedList<ToolCallEvidence> | null;
    repeated_calls: BoundedList<RepeatedCallEvidence>;
    largest_inputs: BoundedList<ToolCallEvidence>;
    largest_outputs: BoundedList<ToolCallEvidence> | null;
  };
  compactions: { count: number | null; timestamps: string[] };
  longest_observed_gaps: BoundedList<GapEvidence> | null;
  assistant_milestones: BoundedList<MilestoneEvidence>;
  subagent_efficiency: BoundedSubagentEfficiencyEvidence;
  unavailable: string[];
}

interface BoundedList<T> {
  total: number;
  returned: number;
  truncated: boolean;
  items: T[];
}

type BoundedSubagentEfficiencyEvidence =
  Omit<SubagentEfficiencyEvidence, "subagents"> & {
    subagents: BoundedList<
      Omit<SubagentSessionEvidence, "activations"> & {
        activations: BoundedList<SubagentActivation>;
      }
    >;
  };

interface ToolCallEvidence {
  sequence: number;
  name: string;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number | null;
  duration_source: "internal_create_time" | "outer_timestamp" | "unavailable";
  completed: boolean | null;
  failed: boolean | null;
  input_preview: string;
  input_chars: number;
  param_count: number;
  output_chars: number | null;
  output_tokens: number | null;
}

interface RepeatedCallEvidence {
  fingerprint: string;
  name: string;
  input_preview: string;
  count: number;
  sequences: number[];
}

interface GapEvidence {
  started_at: string;
  ended_at: string;
  duration_ms: number;
  from: string;
  to: string;
}

interface MilestoneEvidence {
  sequence: number;
  timestamp: string | null;
  phase: string;
  text: string;
}
```

Repeated-call fingerprints are SHA-256 values over tool name plus normalized
unredacted input; raw fingerprint material is never emitted. Every
transcript-derived preview is redacted and bounded.

The subagent aggregate and detail fields reuse the versioned contract defined
in [Subagent efficiency evidence](./subagent-efficiency.md). Turn analysis clips
that evidence to the selected boundary, preserves full execution sum, wall
union, parent wait, maximum parallelism, activation status and availability
provenance, and wraps both `subagents` and each child's `activations` in
`BoundedList`. This bounded wrapper is specific to `turn analyze`; the standalone
`trajrx subagents` contract remains unchanged.

The canonical `unavailable` identifiers are JSON paths, including:

- `elapsed.tool_wait_union_ms`
- `elapsed.tool_wait_sum_ms`
- `elapsed.other_observed_ms`
- `tools.failed_count`
- `tools.incomplete_count`
- `tools.total_output_chars`
- `tools.total_output_tokens`
- `tools.longest_calls`
- `tools.failed_calls`
- `tools.largest_outputs`
- `tools.largest_inputs.items[*].started_at`
- `tools.largest_inputs.items[*].ended_at`
- `tools.largest_inputs.items[*].duration_ms`
- `tools.largest_inputs.items[*].completed`
- `tools.largest_inputs.items[*].failed`
- `tools.largest_inputs.items[*].output_chars`
- `tools.largest_inputs.items[*].output_tokens`
- `compactions.count`
- `longest_observed_gaps`
- `assistant_milestones.items[*].timestamp`

Cursor v1 uses those identifiers for facts absent from its transcript. A
consumer expands each `items[*]` identifier across the corresponding returned
items when checking nullability; it does not require per-index paths. New v1
fields may be added, but existing field meaning, enum values and null-versus-zero
semantics cannot change. A consumer rejects a missing required property, wrong
type, unknown schema/schema version, non-finite or negative duration, or an
unavailable nullable field whose path is absent from `unavailable`.

Every list carries its own `total`, `returned` and `truncated` values. This makes
`--top` visible and prevents a bounded detail list from being mistaken for the
aggregate population.

## Timing and evidence semantics

Codex turn-boundary and milestone placement prefers
`internal_chat_message_metadata_passthrough.create_time`; the outer JSONL
timestamp is an explicit per-endpoint compatibility fallback. Start/end source
is recorded separately. Tool duration deliberately uses the outer call/output
timestamps: on real Codex rollouts the call record's internal `create_time`
marks the beginning of the model response that eventually emitted the call and
would incorrectly charge model reasoning to tool wait. Turn boundaries and
matched call/output pairs must be monotonic; otherwise the command fails instead
of clamping or synthesizing an endpoint. Independent events may be serialized
out of timestamp order during parallel execution; observable-gap evidence sorts
them by observed time instead of treating JSONL placement as chronology.

Tool wait union merges matched call/output intervals and avoids parallel double
counting. Wait sum is reported separately and may double-count overlap. A tool
without an observed output is incomplete and contributes no wait interval.

Cursor total time comes only from the Hook state wall clock. Cursor transcript
rows do not expose per-event timestamps or tool results, so tool wait, failure,
output, compaction and gap timing remain unavailable. File modification time is
not substituted for those facts. Cursor subagent timing keeps its existing
`file_times` provenance.

Tool input parameter and character counts reuse TrajRx's existing input metric
rules. Output tokens use the existing TrajRx estimator over the complete
observed output when the source exposes output text; only emitted previews and
detail row counts are bounded. Tool failure follows the outer execution envelope
and explicit tool error signals. Serialized JSON is interpreted as an envelope
only for known command-execution tools; ordinary function-tool return data is
never reclassified merely because it contains failure-shaped fields. Observable gaps support phase reconstruction but do not
claim model thinking time. Subagent execution sum, wall union and parent wait
are separate metrics and must not be added together.

All transcript-derived strings are redacted before output, including structured
keys or textual CLI/header/env forms containing token, password, secret,
authorization or common API-key spellings. Aggregates are calculated before
previews are bounded.

## Harness invocation protocol

Harness `agent-retro` invokes TrajRx directly; it does not call a Harness-owned
parser or wrapper. Resolution checks at most three candidates in this order:

1. configured/local TrajRx source root: `src/cli.ts`, invoked through that
   checkout's `npm --silent --prefix <root> run dev --` entry;
2. the same root's built `dist/cli.js`, invoked with Node;
3. an installed `trajrx` executable on `PATH`.

The default local root is `~/Projects/trajrx`; an explicitly supplied
`TRAJRX_ROOT` overrides it. The first available candidate is used. If it exits
because dependencies are missing, or its help/output lacks
`trajrx_turn_analysis_v1`, the skill stops and reports the exact candidate plus
a copyable build/install recovery action; it does not continue to a stale lower
priority candidate.

For either client, the skill derives only the non-secret
`<date>/<identity-hash>` locator from the Hook acknowledgement token, joins it
to the Hook's configured state-home path, and passes that directory through
`--hook-state`. The full acknowledgement token is never placed in the TrajRx
process arguments or evidence. Codex normally omits `--session` and lets TrajRx
perform the two-day exact conversation lookup described above. An already known
host-provided rollout path may be passed directly.

After execution, the skill validates the required v1 fields and availability
invariants above before using the evidence. Missing TrajRx, invalid Hook
identity, ambiguous session resolution, bounded-tail exhaustion, malformed
JSONL or incompatible schema are reported as unavailable evidence with the
command's recovery action. There is no silent parser fallback.

TrajRx remains the fact layer. The skill and current Agent classify phases,
decide whether cost was reasonable, diagnose workflow or command friction and
route improvements to an owning surface.

## Verification matrix

| Contract | Evidence |
| --- | --- |
| Codex exact selection and earlier/follow-up exclusion | fixtures with matching/mismatching Hook state, duplicate/missing task boundaries, repeated `turn_context`, multiple user steering messages and `final`/`final_answer` variants |
| Codex timing | internal create time, outer fallback, mixed monotonic endpoints, invalid chronology and overlapping wait union |
| Cursor selection | matching/mismatching Hook state, successful target after failed/aborted turn, ambiguous transcript, complete bounded tail, progressive read and 16 MiB cap failure |
| Availability | Cursor null plus canonical `unavailable` paths; observed Codex zero is not unavailable |
| Tool efficiency | repeated fingerprints, aggregate-before-bound counts, canonical input params/chars, complete large-output chars/tokens and ordering, incomplete calls, successful stdout with failure-shaped data, and explicit nonzero/`isError` failures |
| Secret safety | structured values, quoted CLI flags, env assignments, Authorization/API-key headers and compound secret keys |
| Subagents | sequential/parallel/multi-activation/aborted/incomplete cases clipped to the selected turn, with nested `--top` bounds and preserved aggregates |
| CLI/errors | help, required arguments, JSON schema and actionable non-zero identity/ambiguity/cap errors |
| Harness compatibility | focused test validates skill command/schema paths and confirms `analyze_turn.py` is absent |
| Repository gates | TrajRx `npm test` and `npm run docs:build`; Harness focused tests, docs checks, Candidate Review and cross-repository consistency review |
