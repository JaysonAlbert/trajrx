# Subagent efficiency evidence

TrajRx treats subagent timing as deterministic evidence for a later semantic
review. It does not decide whether a review round was justified or whether a
command is defective. Those conclusions remain the responsibility of the
consumer, such as the `agent-retro` skill.

## Time semantics

Three durations are reported separately because they answer different
questions and cannot be added together:

| Metric | Meaning |
| --- | --- |
| `execution_sum_ms` | Sum of every observed subagent activation. This is total agent effort and double-counts parallel work by design. |
| `wall_union_ms` | Union of all subagent activation intervals. This is the elapsed wall-clock span attributable to subagent execution without double-counting overlap. |
| `parent_wait_ms` | Union of the parent session's explicit subagent-wait tool intervals. This is how long the parent was blocked in an observed wait call. |

`max_parallelism` is the largest number of overlapping activation intervals.
`parent_wait_count` reports how many explicit wait intervals intersected the
selected scope, which helps explain multi-round or repeated reviewer waits.
`aborted_count` keeps interrupted review/exploration work visible as an explicit
friction signal; its observed start-to-abort interval still contributes to time.
Per-session and per-activation rows retain the task path/name so a semantic
consumer can group Candidate Review roles and rounds without TrajRx guessing
workflow meaning.

## Source precision

Codex rollout files expose a direct parent identifier in
`session_meta.source.subagent.thread_spawn.parent_thread_id`. Subagent
activations expose `task_started` and `task_complete` events, including an
observed duration. TrajRx prefers task `started_at` / `completed_at` payloads
and `internal_chat_message_metadata_passthrough.create_time` on parent
`wait_agent` calls and outputs. The outer JSONL timestamp is only a compatibility
fallback because some rollouts serialize events later than their observed
execution time.

Cursor stores child transcripts below the parent transcript directory in
`subagents/*.jsonl`, but the transcript rows do not expose event timestamps.
TrajRx uses file birth and modification times as an approximation, labels the
timing source `file_times`, and leaves parent wait time unavailable. It must not
replace an unavailable value with a synthetic duration.

## Output contract

Full analysis writes `subagent_efficiency.json` and embeds the same versioned
object in `trajectory_ir.json` metadata. The report shows the four summary
metrics plus bounded per-subagent rows.

For Hook-triggered retrospectives, `trajrx subagents <transcript> --from <ISO>
--to <ISO> --json` restricts the evidence to the triggering turn. Activations
and waits that cross a boundary are clipped to the intersection. Omitting the
window intentionally reports the whole task/thread.

The artifact includes an `unavailable` list. A `null` value means that the
source cannot support the metric; zero means the extractor observed the metric
and found no matching interval.

## Relationship to comprehensive efficiency analysis

Subagent evidence complements existing deterministic TrajRx evidence:

- session gross/active wall time and user idle;
- per-tool duration and output tokens;
- repeated command fingerprints, retry and loop signals;
- explicit failures;
- tool input parameter and character counts;
- high-output and high-input optimization candidates.

An Agent can use these artifacts to judge phase reasonableness, explain
multi-round review cost, and distinguish workflow latency from command/tooling
friction. Semantic labels and causal conclusions are intentionally not encoded
as static TrajRx facts.
