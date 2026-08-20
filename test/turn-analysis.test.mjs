import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { estimateTokens } from "../dist/enrich/toolMetrics.js";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(rootDir, "dist", "cli.js");

function fixtureSecret(label) {
  return ["fixture", label, "value"].join("-");
}

function writeJsonl(path, rows) {
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

function observed(timestamp) {
  return { internal_chat_message_metadata_passthrough: { create_time: Date.parse(timestamp) / 1000 } };
}

function codexMessage(timestamp, role, text, phase) {
  return {
    timestamp,
    type: "response_item",
    payload: {
      type: "message",
      role,
      ...(phase ? { phase } : {}),
      content: [{ type: role === "user" ? "input_text" : "output_text", text }],
      ...observed(timestamp),
    },
  };
}

function codexCall(timestamp, id, input, outerTimestamp = timestamp, name = "exec") {
  return {
    timestamp: outerTimestamp,
    type: "response_item",
    payload: {
      type: "custom_tool_call",
      name,
      call_id: id,
      input: JSON.stringify(input),
      ...observed(timestamp),
    },
  };
}

function codexOutput(timestamp, id, output, outerTimestamp = timestamp) {
  return {
    timestamp: outerTimestamp,
    type: "response_item",
    payload: {
      type: "custom_tool_call_output",
      call_id: id,
      output,
      ...observed(timestamp),
    },
  };
}

function writeHookState(path, { client, conversationId, turnId, startedAt, requestedAt }) {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "start.json"), JSON.stringify({
    schema: "harness_agent_hook_turn_v1",
    client,
    conversationId,
    turnId,
    startedWallNs: Date.parse(startedAt) * 1_000_000,
  }), "utf8");
  writeFileSync(join(path, "request.json"), JSON.stringify({
    schema: "harness_agent_hook_request_v1",
    client,
    conversationId,
    turnId,
    requestId: "request-1",
    requestedWallNs: Date.parse(requestedAt) * 1_000_000,
  }), "utf8");
}

test("trajrx turn analyze emits scoped Codex evidence with exact observed timing", () => {
  const temp = mkdtempSync(join(tmpdir(), "trajrx-turn-codex-"));
  const day = join(temp, "codex", "sessions", "2026", "08", "20");
  const hookState = join(temp, "hook-state");
  mkdirSync(day, { recursive: true });
  const parent = join(day, "rollout-parent.jsonl");
  const tokenSecret = fixtureSecret("token");
  const tokenOption = ["--", "token"].join("");
  const tokenCommand = ["harness test", tokenOption, tokenSecret, "--json"].join(" ");
  const authorizationSecret = fixtureSecret("authorization");
  writeJsonl(parent, [
    { timestamp: "2026-08-20T00:00:00.000Z", type: "session_meta", payload: { id: "parent" } },
    { timestamp: "2026-08-20T00:00:07.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "unrelated-turn" } },
    { timestamp: "2026-08-20T00:00:08.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "target-turn" } },
    { timestamp: "2026-08-20T00:00:09.000Z", type: "turn_context", payload: { turn_id: "target-turn" } },
    codexMessage("2026-08-20T00:00:10.000Z", "user", "implement canonical turn analysis"),
    { timestamp: "2026-08-20T00:00:11.000Z", type: "turn_context", payload: { turn_id: "target-turn" } },
    codexCall("2026-08-20T00:00:10.000Z", "call-1", {
      cmd: tokenCommand,
      max_output_tokens: 20000,
    }, "2026-08-20T00:00:12.000Z"),
    codexCall("2026-08-20T00:00:10.500Z", "call-2", {
      cmd: tokenCommand,
      max_output_tokens: 20000,
    }, "2026-08-20T00:00:13.000Z"),
    codexOutput("2026-08-20T00:00:15.000Z", "call-2", {
      exit_code: 2,
      wall_time_seconds: 2,
      output: ["Authorization", ": Basic ", authorizationSecret].join(""),
    }, "2026-08-20T00:00:15.000Z"),
    codexOutput("2026-08-20T00:00:15.500Z", "call-1", {
      exit_code: 0,
      wall_time_seconds: 4,
      output: "completed output",
    }, "2026-08-20T00:00:16.000Z"),
    codexMessage("2026-08-20T00:00:17.000Z", "user", "steer within the same turn"),
    codexMessage("2026-08-20T00:00:18.000Z", "assistant", "implementation checkpoint", "commentary"),
    { timestamp: "2026-08-20T00:00:19.000Z", type: "compacted", payload: {} },
    codexMessage("2026-08-20T00:00:20.000Z", "assistant", "done", "final_answer"),
    codexMessage("2026-08-20T00:00:21.100Z", "user", "Hook continuation"),
    codexMessage("2026-08-20T00:00:22.000Z", "assistant", "retro follow-up", "final"),
    { timestamp: "2026-08-20T00:00:21.000Z", type: "event_msg", payload: { type: "task_complete", turn_id: "target-turn" } },
  ]);
  writeHookState(hookState, {
    client: "codex",
    conversationId: "parent",
    turnId: "target-turn",
    startedAt: "2026-08-20T00:00:09.000Z",
    requestedAt: "2026-08-20T00:00:20.100Z",
  });
  writeJsonl(join(day, "rollout-child.jsonl"), [
    {
      timestamp: "2026-08-20T00:00:11.000Z",
      type: "session_meta",
      payload: {
        id: "child",
        source: { subagent: { thread_spawn: { parent_thread_id: "parent", depth: 1, agent_path: "/root/review" } } },
      },
    },
    {
      timestamp: "2026-08-20T00:00:11.000Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: "review", started_at: Date.parse("2026-08-20T00:00:11.000Z") / 1000 },
    },
    {
      timestamp: "2026-08-20T00:00:14.000Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "review",
        started_at: Date.parse("2026-08-20T00:00:11.000Z") / 1000,
        completed_at: Date.parse("2026-08-20T00:00:14.000Z") / 1000,
        duration_ms: 3000,
      },
    },
  ]);

  const result = spawnSync(process.execPath, [
    cliPath,
    "turn",
    "analyze",
    "--client",
    "codex",
    "--hook-state",
    hookState,
    "--session",
    parent,
    "--top",
    "1",
    "--json",
  ], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.schema, "trajrx_turn_analysis_v1");
  assert.equal(evidence.source, "codex");
  assert.equal(evidence.boundary.started_at, "2026-08-20T00:00:10.000Z");
  assert.equal(evidence.boundary.ended_at, "2026-08-20T00:00:20.000Z");
  assert.doesNotMatch(evidence.boundary.final_preview, /retro follow-up/);
  assert.equal(evidence.elapsed.total_ms, 10000);
  assert.equal(evidence.elapsed.tool_wait_union_ms, 4000);
  assert.equal(evidence.elapsed.tool_wait_sum_ms, 6000);
  assert.equal(evidence.tools.call_count, 2);
  assert.equal(evidence.tools.failed_count, 1);
  assert.equal(evidence.tools.repeated_calls.total, 1);
  assert.equal(evidence.tools.repeated_calls.items[0].count, 2);
  assert.equal(evidence.tools.longest_calls.total, 2);
  assert.equal(evidence.tools.longest_calls.returned, 1);
  assert.equal(evidence.tools.longest_calls.truncated, true);
  assert.doesNotMatch(JSON.stringify(evidence), new RegExp(`${tokenSecret}|${authorizationSecret}`));
  assert.equal(evidence.compactions.count, 1);
  assert.equal(evidence.subagent_efficiency.execution_sum_ms, 3000);
  assert.equal(evidence.subagent_efficiency.wall_union_ms, 3000);
  assert.deepEqual(evidence.unavailable, []);
});

test("Codex tool wait uses outer call/output timestamps instead of model response create time", () => {
  const temp = mkdtempSync(join(tmpdir(), "trajrx-turn-tool-time-"));
  const session = join(temp, "rollout.jsonl");
  const hookState = join(temp, "hook-state");
  const call = codexCall("2026-08-20T00:00:02.000Z", "call-1", { cmd: "focused check" });
  call.timestamp = "2026-08-20T00:00:05.000Z";
  const output = codexOutput("2026-08-20T00:00:09.000Z", "call-1", { exit_code: 0, output: "done" });
  output.timestamp = "2026-08-20T00:00:06.000Z";
  writeJsonl(session, [
    { timestamp: "2026-08-20T00:00:00.000Z", type: "session_meta", payload: { id: "parent" } },
    { timestamp: "2026-08-20T00:00:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "target-turn" } },
    { timestamp: "2026-08-20T00:00:00.500Z", type: "turn_context", payload: { turn_id: "target-turn" } },
    codexMessage("2026-08-20T00:00:01.000Z", "user", "target"),
    call,
    output,
    codexMessage("2026-08-20T00:00:10.000Z", "assistant", "done", "final"),
  ]);
  writeHookState(hookState, {
    client: "codex",
    conversationId: "parent",
    turnId: "target-turn",
    startedAt: "2026-08-20T00:00:00.000Z",
    requestedAt: "2026-08-20T00:00:10.100Z",
  });

  const result = spawnSync(process.execPath, [
    cliPath,
    "turn",
    "analyze",
    "--client",
    "codex",
    "--hook-state",
    hookState,
    "--session",
    session,
    "--json",
  ], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.elapsed.tool_wait_union_ms, 1000);
  assert.equal(evidence.tools.longest_calls.items[0].duration_ms, 1000);
  assert.equal(evidence.tools.longest_calls.items[0].duration_source, "outer_timestamp");
});

test("trajrx turn analyze emits honest Cursor availability", () => {
  const temp = mkdtempSync(join(tmpdir(), "trajrx-turn-cursor-"));
  const cursorHome = join(temp, "cursor");
  const conversationId = "conversation-1";
  const sessionDir = join(cursorHome, "projects", "repo", "agent-transcripts", conversationId);
  const hookState = join(temp, "hook-state");
  mkdirSync(join(sessionDir, "subagents"), { recursive: true });
  mkdirSync(hookState, { recursive: true });
  const session = join(sessionDir, `${conversationId}.jsonl`);
  const cursorSecret = fixtureSecret("cursor-token");
  const cursorTokenOption = ["--", "token"].join("");
  const shortCommand = ["harness status", cursorTokenOption, cursorSecret].join(" ");
  const longCommand = [shortCommand, "--verbose --project very-long-project-name"].join(" ");
  writeJsonl(session, [
    { role: "user", message: { content: [{ type: "text", text: "<user_query>earlier</user_query>" }] } },
    { role: "assistant", message: { content: [{ type: "text", text: "earlier final" }] } },
    { type: "turn_ended", status: "completed" },
    { role: "user", message: { content: [{ type: "text", text: "<user_query>MUST-EXCLUDE aborted turn</user_query>" }] } },
    {
      role: "assistant",
      message: { content: [{ type: "tool_use", name: "Shell", input: { command: "MUST-EXCLUDE command" } }] },
    },
    { type: "turn_ended", status: "error" },
    { role: "user", message: { content: [{ type: "text", text: "<user_query>target turn</user_query>" }] } },
    {
      role: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Shell", input: { command: shortCommand } },
          { type: "tool_use", name: "Shell", input: { command: shortCommand } },
          { type: "tool_use", name: "Shell", input: { command: longCommand } },
          { type: "text", text: "target final" },
        ],
      },
    },
    { type: "turn_ended", status: "completed" },
  ]);
  writeJsonl(join(sessionDir, "subagents", "child.jsonl"), [
    { role: "assistant", message: { content: [{ type: "text", text: "child" }] } },
  ]);
  const startedNs = Date.parse("2026-08-20T00:00:00.000Z") * 1_000_000;
  const requestedNs = Date.parse("2026-08-20T00:00:30.000Z") * 1_000_000;
  writeFileSync(join(hookState, "start.json"), JSON.stringify({
    schema: "harness_agent_hook_turn_v1",
    client: "cursor",
    conversationId,
    turnId: "generation-1",
    startedWallNs: startedNs,
  }), "utf8");
  writeFileSync(join(hookState, "request.json"), JSON.stringify({
    schema: "harness_agent_hook_request_v1",
    client: "cursor",
    conversationId,
    turnId: "generation-1",
    requestId: "request-1",
    requestedWallNs: requestedNs,
  }), "utf8");

  const result = spawnSync(process.execPath, [
    cliPath,
    "turn",
    "analyze",
    "--client",
    "cursor",
    "--hook-state",
    hookState,
    "--cursor-home",
    cursorHome,
    "--top",
    "1",
    "--json",
  ], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.source, "cursor");
  assert.equal(evidence.elapsed.total_ms, 30000);
  assert.equal(evidence.elapsed.tool_wait_union_ms, null);
  assert.equal(evidence.tools.call_count, 3);
  assert.equal(evidence.tools.repeated_calls.total, 1);
  assert.equal(evidence.tools.total_input_chars, 2 * shortCommand.length + longCommand.length);
  assert.equal(evidence.tools.largest_inputs.items[0].input_chars, longCommand.length);
  assert.match(evidence.tools.largest_inputs.items[0].input_preview, /very-long-project-name/);
  assert.equal(evidence.tools.total_output_tokens, null);
  assert.ok(evidence.unavailable.includes("tools.total_output_tokens"));
  assert.ok(evidence.unavailable.includes("longest_observed_gaps"));
  assert.ok(evidence.unavailable.includes("tools.largest_inputs.items[*].duration_ms"));
  assert.ok(evidence.unavailable.includes("assistant_milestones.items[*].timestamp"));
  assert.doesNotMatch(JSON.stringify(evidence), /MUST-EXCLUDE/);
  assert.doesNotMatch(JSON.stringify(evidence), new RegExp(cursorSecret));
});

test("Codex recognizes real context_compacted events in counts, timestamps, and gaps", () => {
  const temp = mkdtempSync(join(tmpdir(), "trajrx-turn-compaction-"));
  const session = join(temp, "rollout.jsonl");
  const hookState = join(temp, "hook-state");
  writeJsonl(session, [
    { timestamp: "2026-08-20T00:00:00.000Z", type: "session_meta", payload: { id: "parent" } },
    { timestamp: "2026-08-20T00:00:00.100Z", type: "event_msg", payload: { type: "task_started", turn_id: "target" } },
    codexMessage("2026-08-20T00:00:01.000Z", "user", "target"),
    { timestamp: "2026-08-20T00:00:04.000Z", type: "event_msg", payload: { type: "context_compacted" } },
    codexMessage("2026-08-20T00:00:05.000Z", "assistant", "done", "final"),
  ]);
  writeHookState(hookState, {
    client: "codex",
    conversationId: "parent",
    turnId: "target",
    startedAt: "2026-08-20T00:00:00.000Z",
    requestedAt: "2026-08-20T00:00:06.000Z",
  });

  const result = spawnSync(process.execPath, [
    cliPath, "turn", "analyze", "--client", "codex", "--hook-state", hookState,
    "--session", session, "--top", "10", "--json",
  ], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(result.stdout);
  assert.deepEqual(evidence.compactions, {
    count: 1,
    timestamps: ["2026-08-20T00:00:04.000Z"],
  });
  assert.ok(evidence.longest_observed_gaps.items.some((gap) => gap.to === "context_compacted"));
  assert.ok(evidence.longest_observed_gaps.items.some((gap) => gap.from === "context_compacted"));
});

test("Codex honors failure envelopes, redacts API keys, and measures complete large outputs", () => {
  const temp = mkdtempSync(join(tmpdir(), "trajrx-turn-tools-"));
  const session = join(temp, "rollout.jsonl");
  const hookState = join(temp, "hook-state");
  const largeOutput = "x".repeat(600_000);
  const apiSecrets = {
    structuredOne: fixtureSecret("structured-one"),
    structuredTwo: fixtureSecret("structured-two"),
    structuredThree: fixtureSecret("structured-three"),
    flag: fixtureSecret("flag"),
    env: fixtureSecret("env"),
    header: fixtureSecret("header"),
  };
  const apiOption = ["--api", "key"].join("-");
  const apiEnv = ["API", "KEY"].join("_");
  const apiHeader = ["X-API", "Key"].join("-");
  const apiInput = {
    api_key: apiSecrets.structuredOne,
    API_KEY: apiSecrets.structuredTwo,
    "api-key": apiSecrets.structuredThree,
    command: [
      "tool",
      apiOption,
      apiSecrets.flag,
      `${apiEnv}=${apiSecrets.env}`,
      `${apiHeader}:`,
      apiSecrets.header,
    ].join(" "),
  };
  writeJsonl(session, [
    { timestamp: "2026-08-20T00:00:00.000Z", type: "session_meta", payload: { id: "parent" } },
    { timestamp: "2026-08-20T00:00:00.100Z", type: "event_msg", payload: { type: "task_started", turn_id: "target" } },
    codexMessage("2026-08-20T00:00:01.000Z", "user", "target"),
    codexCall("2026-08-20T00:00:02.000Z", "success", apiInput),
    codexOutput("2026-08-20T00:00:03.000Z", "success", {
      exit_code: 0,
      output: '{"exit_code":2,"isError":true}',
    }),
    codexCall("2026-08-20T00:00:03.100Z", "nonzero", { cmd: "fail" }),
    codexOutput("2026-08-20T00:00:04.000Z", "nonzero", { exit_code: 2, output: "failed" }),
    codexCall("2026-08-20T00:00:04.100Z", "is-error", { cmd: "fail other" }),
    codexOutput("2026-08-20T00:00:05.000Z", "is-error", { isError: true, content: [] }),
    codexCall("2026-08-20T00:00:05.100Z", "large", { cmd: "large" }),
    codexOutput("2026-08-20T00:00:06.000Z", "large", { exit_code: 0, output: largeOutput }),
    codexCall("2026-08-20T00:00:06.050Z", "reader-data", { path: "result.json" }, undefined, "reader"),
    codexOutput("2026-08-20T00:00:06.075Z", "reader-data", '{"exit_code":2,"isError":true}'),
    codexCall("2026-08-20T00:00:06.100Z", "incomplete", { cmd: "still running" }),
    codexMessage("2026-08-20T00:00:07.000Z", "assistant", "done", "final"),
  ]);
  writeHookState(hookState, {
    client: "codex",
    conversationId: "parent",
    turnId: "target",
    startedAt: "2026-08-20T00:00:00.000Z",
    requestedAt: "2026-08-20T00:00:08.000Z",
  });

  const result = spawnSync(process.execPath, [
    cliPath, "turn", "analyze", "--client", "codex", "--hook-state", hookState,
    "--session", session, "--top", "10", "--json",
  ], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });

  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.tools.failed_count, 2);
  assert.deepEqual(evidence.tools.failed_calls.items.map((call) => call.sequence), [2, 3]);
  assert.equal(evidence.tools.incomplete_count, 1);
  assert.equal(evidence.tools.longest_calls.items.find((call) => call.sequence === 6).duration_ms, null);
  const largeRawOutput = JSON.stringify({ exit_code: 0, output: largeOutput });
  assert.equal(
    evidence.tools.largest_outputs.items.find((call) => call.sequence === 4).output_tokens,
    estimateTokens(largeRawOutput),
  );
  assert.equal(evidence.tools.largest_outputs.items[0].sequence, 4);
  assert.equal(
    evidence.tools.total_output_chars,
    [
      { exit_code: 0, output: '{"exit_code":2,"isError":true}' },
      { exit_code: 2, output: "failed" },
      { isError: true, content: [] },
      { exit_code: 0, output: largeOutput },
      '{"exit_code":2,"isError":true}',
    ].reduce((sum, output) => sum + (typeof output === "string" ? output : JSON.stringify(output)).length, 0),
  );
  assert.equal(
    evidence.tools.total_output_tokens,
    [
      { exit_code: 0, output: '{"exit_code":2,"isError":true}' },
      { exit_code: 2, output: "failed" },
      { isError: true, content: [] },
      { exit_code: 0, output: largeOutput },
      '{"exit_code":2,"isError":true}',
    ].reduce((sum, output) => sum + estimateTokens(typeof output === "string" ? output : JSON.stringify(output)), 0),
  );
  const serialized = JSON.stringify(evidence);
  for (const secret of Object.values(apiSecrets)) {
    assert.doesNotMatch(serialized, new RegExp(secret));
  }
});

test("Codex bounds subagent and activation details while preserving full aggregates", () => {
  const temp = mkdtempSync(join(tmpdir(), "trajrx-turn-subagent-bounds-"));
  const day = join(temp, "codex", "sessions", "2026", "08", "20");
  const hookState = join(temp, "hook-state");
  mkdirSync(day, { recursive: true });
  const parent = join(day, "rollout-parent.jsonl");
  writeJsonl(parent, [
    { timestamp: "2026-08-20T00:00:00.000Z", type: "session_meta", payload: { id: "parent" } },
    { timestamp: "2026-08-20T00:00:00.100Z", type: "event_msg", payload: { type: "task_started", turn_id: "target" } },
    codexMessage("2026-08-20T00:00:01.000Z", "user", "target"),
    codexMessage("2026-08-20T00:00:20.000Z", "assistant", "done", "final"),
  ]);
  const childMeta = (id, task) => ({
    timestamp: "2026-08-20T00:00:01.000Z",
    type: "session_meta",
    payload: { id, source: { subagent: { thread_spawn: { parent_thread_id: "parent", depth: 1, agent_path: task } } } },
  });
  const taskEvent = (timestamp, type, turnId, extra = {}) => ({
    timestamp,
    type: "event_msg",
    payload: { type, turn_id: turnId, ...extra },
  });
  writeJsonl(join(day, "rollout-child-a.jsonl"), [
    childMeta("child-a", "/root/review-r1"),
    taskEvent("2026-08-20T00:00:02.000Z", "task_started", "a1"),
    taskEvent("2026-08-20T00:00:04.000Z", "task_complete", "a1", { duration_ms: 2000 }),
    taskEvent("2026-08-20T00:00:08.000Z", "task_started", "a2"),
    taskEvent("2026-08-20T00:00:10.000Z", "turn_aborted", "a2", { duration_ms: 2000 }),
  ]);
  writeJsonl(join(day, "rollout-child-b.jsonl"), [
    childMeta("child-b", "/root/review-r2"),
    taskEvent("2026-08-20T00:00:03.000Z", "task_started", "b1"),
    taskEvent("2026-08-20T00:00:06.000Z", "task_complete", "b1", { duration_ms: 3000 }),
  ]);
  writeJsonl(join(day, "rollout-child-c.jsonl"), [
    childMeta("child-c", "/root/review-r3"),
    taskEvent("2026-08-20T00:00:12.000Z", "task_started", "c1"),
  ]);
  writeHookState(hookState, {
    client: "codex", conversationId: "parent", turnId: "target",
    startedAt: "2026-08-20T00:00:00.000Z", requestedAt: "2026-08-20T00:00:21.000Z",
  });

  const result = spawnSync(process.execPath, [
    cliPath, "turn", "analyze", "--client", "codex", "--hook-state", hookState,
    "--session", parent, "--top", "1", "--json",
  ], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(result.stdout).subagent_efficiency;
  assert.equal(evidence.subagent_count, 3);
  assert.equal(evidence.activation_count, 4);
  assert.equal(evidence.aborted_count, 1);
  assert.equal(evidence.max_parallelism, 2);
  assert.ok(evidence.unavailable.includes("incomplete_activation_duration"));
  assert.deepEqual(
    [evidence.subagents.total, evidence.subagents.returned, evidence.subagents.truncated],
    [3, 1, true],
  );
  assert.deepEqual(
    [evidence.subagents.items[0].activations.total, evidence.subagents.items[0].activations.returned, evidence.subagents.items[0].activations.truncated],
    [2, 1, true],
  );
});

test("Codex Hook cutoff preserves sub-millisecond requestedWallNs precision", () => {
  const temp = mkdtempSync(join(tmpdir(), "trajrx-turn-sub-ms-cutoff-"));
  const session = join(temp, "rollout.jsonl");
  const hookState = join(temp, "hook-state");
  const beforeRequest = codexMessage("2026-08-20T00:00:10.001Z", "assistant", "selected final", "final");
  beforeRequest.payload.internal_chat_message_metadata_passthrough.create_time =
    Date.parse("2026-08-20T00:00:10.000Z") / 1000 + 0.0005;
  const afterRequest = codexMessage("2026-08-20T00:00:10.002Z", "assistant", "continuation final", "final");
  afterRequest.payload.internal_chat_message_metadata_passthrough.create_time =
    Date.parse("2026-08-20T00:00:10.000Z") / 1000 + 0.0009;
  writeJsonl(session, [
    { timestamp: "2026-08-20T00:00:00.000Z", type: "session_meta", payload: { id: "parent" } },
    { timestamp: "2026-08-20T00:00:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "target-turn" } },
    codexMessage("2026-08-20T00:00:01.000Z", "user", "target"),
    beforeRequest,
    afterRequest,
  ]);
  writeHookState(hookState, {
    client: "codex",
    conversationId: "parent",
    turnId: "target-turn",
    startedAt: "2026-08-20T00:00:00.000Z",
    requestedAt: "2026-08-20T00:00:10.000Z",
  });
  const requestPath = join(hookState, "request.json");
  const request = JSON.parse(readFileSync(requestPath, "utf8"));
  request.requestedWallNs += 800_000;
  writeFileSync(requestPath, JSON.stringify(request), "utf8");

  const result = spawnSync(process.execPath, [
    cliPath,
    "turn",
    "analyze",
    "--client",
    "codex",
    "--hook-state",
    hookState,
    "--session",
    session,
    "--json",
  ], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.boundary.final_preview, "selected final");
  assert.doesNotMatch(evidence.boundary.final_preview, /continuation/);
});

test("trajrx turn analyze requires exact Hook state", () => {
  const result = spawnSync(process.execPath, [cliPath, "turn", "analyze", "--client", "codex", "--json"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--hook-state is required/);
});

test("trajrx turn analyze help exposes the stable machine contract", () => {
  const result = spawnSync(process.execPath, [cliPath, "turn", "analyze", "--help"], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /trajrx turn analyze --client codex/);
  assert.match(result.stdout, /--hook-state/);
  assert.match(result.stdout, /--top N/);
  assert.match(result.stdout, /trajrx_turn_analysis_v1/);
});

test("trajrx turn analyze rejects duplicate Codex turn starts", () => {
  const temp = mkdtempSync(join(tmpdir(), "trajrx-turn-duplicate-start-"));
  const session = join(temp, "rollout.jsonl");
  const hookState = join(temp, "hook-state");
  const start = { timestamp: "2026-08-20T00:00:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "duplicate-turn" } };
  writeJsonl(session, [
    { timestamp: "2026-08-20T00:00:00.000Z", type: "session_meta", payload: { id: "parent" } },
    start,
    start,
    codexMessage("2026-08-20T00:00:01.000Z", "user", "target"),
    codexMessage("2026-08-20T00:00:02.000Z", "assistant", "done", "final"),
  ]);
  writeHookState(hookState, {
    client: "codex",
    conversationId: "parent",
    turnId: "duplicate-turn",
    startedAt: "2026-08-20T00:00:00.000Z",
    requestedAt: "2026-08-20T00:00:03.000Z",
  });

  const result = spawnSync(process.execPath, [
    cliPath,
    "turn",
    "analyze",
    "--client",
    "codex",
    "--hook-state",
    hookState,
    "--session",
    session,
    "--json",
  ], { encoding: "utf8" });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /multiple Codex task_started records/);
});

test("trajrx turn analyze rejects a missing exact Codex task boundary", () => {
  const temp = mkdtempSync(join(tmpdir(), "trajrx-turn-missing-start-"));
  const session = join(temp, "rollout.jsonl");
  const hookState = join(temp, "hook-state");
  writeJsonl(session, [
    { timestamp: "2026-08-20T00:00:00.000Z", type: "session_meta", payload: { id: "parent" } },
    { timestamp: "2026-08-20T00:00:00.100Z", type: "event_msg", payload: { type: "task_started", turn_id: "other" } },
    codexMessage("2026-08-20T00:00:01.000Z", "user", "target"),
    codexMessage("2026-08-20T00:00:02.000Z", "assistant", "done", "final"),
  ]);
  writeHookState(hookState, {
    client: "codex", conversationId: "parent", turnId: "missing",
    startedAt: "2026-08-20T00:00:00.000Z", requestedAt: "2026-08-20T00:00:03.000Z",
  });

  const result = spawnSync(process.execPath, [
    cliPath, "turn", "analyze", "--client", "codex", "--hook-state", hookState,
    "--session", session, "--json",
  ], { encoding: "utf8" });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /no Codex task_started found/);
});

test("Codex boundary timestamps fall back to outer JSONL timestamps", () => {
  const temp = mkdtempSync(join(tmpdir(), "trajrx-turn-outer-fallback-"));
  const session = join(temp, "rollout.jsonl");
  const hookState = join(temp, "hook-state");
  const user = codexMessage("2026-08-20T00:00:01.000Z", "user", "target");
  const final = codexMessage("2026-08-20T00:00:02.000Z", "assistant", "done", "final");
  delete user.payload.internal_chat_message_metadata_passthrough;
  delete final.payload.internal_chat_message_metadata_passthrough;
  writeJsonl(session, [
    { timestamp: "2026-08-20T00:00:00.000Z", type: "session_meta", payload: { id: "parent" } },
    { timestamp: "2026-08-20T00:00:00.100Z", type: "event_msg", payload: { type: "task_started", turn_id: "target" } },
    user,
    final,
  ]);
  writeHookState(hookState, {
    client: "codex", conversationId: "parent", turnId: "target",
    startedAt: "2026-08-20T00:00:00.000Z", requestedAt: "2026-08-20T00:00:03.000Z",
  });

  const result = spawnSync(process.execPath, [
    cliPath, "turn", "analyze", "--client", "codex", "--hook-state", hookState,
    "--session", session, "--json",
  ], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.boundary.start_time_source, "outer_timestamp");
  assert.equal(evidence.boundary.end_time_source, "outer_timestamp");
  assert.equal(evidence.elapsed.total_ms, 1000);
});

test("trajrx turn analyze rejects non-monotonic Codex observed time", () => {
  const temp = mkdtempSync(join(tmpdir(), "trajrx-turn-non-monotonic-"));
  const session = join(temp, "rollout.jsonl");
  const hookState = join(temp, "hook-state");
  writeJsonl(session, [
    { timestamp: "2026-08-20T00:00:00.000Z", type: "session_meta", payload: { id: "parent" } },
    { timestamp: "2026-08-20T00:00:00.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "non-monotonic" } },
    { timestamp: "2026-08-20T00:00:00.000Z", type: "turn_context", payload: { turn_id: "non-monotonic" } },
    codexMessage("2026-08-20T00:00:02.000Z", "user", "target"),
    codexMessage("2026-08-20T00:00:01.000Z", "assistant", "done", "final"),
  ]);
  writeHookState(hookState, {
    client: "codex",
    conversationId: "parent",
    turnId: "non-monotonic",
    startedAt: "2026-08-20T00:00:00.000Z",
    requestedAt: "2026-08-20T00:00:03.000Z",
  });

  const result = spawnSync(process.execPath, [
    cliPath,
    "turn",
    "analyze",
    "--client",
    "codex",
    "--hook-state",
    hookState,
    "--session",
    session,
    "--json",
  ], { encoding: "utf8" });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /non-monotonic observed timestamps/);
});

test("trajrx turn analyze rejects mismatched Cursor Hook identity", () => {
  const temp = mkdtempSync(join(tmpdir(), "trajrx-turn-cursor-identity-"));
  writeFileSync(join(temp, "start.json"), JSON.stringify({
    schema: "harness_agent_hook_turn_v1",
    client: "cursor",
    conversationId: "conversation-1",
    turnId: "generation-1",
    startedWallNs: 1_000_000,
  }), "utf8");
  writeFileSync(join(temp, "request.json"), JSON.stringify({
    schema: "harness_agent_hook_request_v1",
    client: "cursor",
    conversationId: "conversation-2",
    turnId: "generation-1",
    requestId: "request-1",
    requestedWallNs: 2_000_000,
  }), "utf8");

  const result = spawnSync(process.execPath, [
    cliPath,
    "turn",
    "analyze",
    "--client",
    "cursor",
    "--hook-state",
    temp,
    "--json",
  ], { encoding: "utf8" });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /identity does not match/);
});

test("Cursor transcript resolution rejects ambiguous project matches", () => {
  const temp = mkdtempSync(join(tmpdir(), "trajrx-turn-cursor-ambiguous-"));
  const cursorHome = join(temp, "cursor");
  const hookState = join(temp, "hook-state");
  const conversationId = "same-conversation";
  for (const project of ["one", "two"]) {
    const dir = join(cursorHome, "projects", project, "agent-transcripts", conversationId);
    mkdirSync(dir, { recursive: true });
    writeJsonl(join(dir, `${conversationId}.jsonl`), [
      { role: "user", message: { content: [{ type: "text", text: "target" }] } },
      { role: "assistant", message: { content: [{ type: "text", text: "done" }] } },
      { type: "turn_ended", status: "completed" },
    ]);
  }
  writeHookState(hookState, {
    client: "cursor", conversationId, turnId: "generation",
    startedAt: "2026-08-20T00:00:00.000Z", requestedAt: "2026-08-20T00:00:01.000Z",
  });

  const result = spawnSync(process.execPath, [
    cliPath, "turn", "analyze", "--client", "cursor", "--hook-state", hookState,
    "--cursor-home", cursorHome, "--json",
  ], { encoding: "utf8" });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /multiple main Cursor transcripts/);
});

test("Cursor progressively grows its bounded tail to prove the prior turn boundary", () => {
  const temp = mkdtempSync(join(tmpdir(), "trajrx-turn-cursor-tail-growth-"));
  const conversationId = "conversation-tail";
  const sessionDir = join(temp, "agent-transcripts", conversationId);
  const session = join(sessionDir, `${conversationId}.jsonl`);
  const hookState = join(temp, "hook-state");
  mkdirSync(sessionDir, { recursive: true });
  writeJsonl(session, [
    { role: "user", message: { content: [{ type: "text", text: "earlier" }] } },
    { role: "assistant", message: { content: [{ type: "text", text: "earlier done" }] } },
    { type: "turn_ended", status: "completed" },
    { type: "metadata", padding: "x".repeat(2_200_000) },
    { role: "user", message: { content: [{ type: "text", text: "<user_query>target</user_query>" }] } },
    { role: "assistant", message: { content: [{ type: "text", text: "target done" }] } },
    { type: "turn_ended", status: "completed" },
  ]);
  writeHookState(hookState, {
    client: "cursor", conversationId, turnId: "generation",
    startedAt: "2026-08-20T00:00:00.000Z", requestedAt: "2026-08-20T00:00:01.000Z",
  });

  const result = spawnSync(process.execPath, [
    cliPath, "turn", "analyze", "--client", "cursor", "--hook-state", hookState,
    "--session", session, "--json",
  ], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.boundary.user_preview, "target");
  assert.equal(evidence.boundary.final_preview, "target done");
});

test("Cursor fails closed when the exact target exceeds the 16 MiB tail cap", () => {
  const temp = mkdtempSync(join(tmpdir(), "trajrx-turn-cursor-tail-cap-"));
  const conversationId = "conversation-tail-cap";
  const sessionDir = join(temp, "agent-transcripts", conversationId);
  const session = join(sessionDir, `${conversationId}.jsonl`);
  const hookState = join(temp, "hook-state");
  mkdirSync(sessionDir, { recursive: true });
  writeJsonl(session, [
    { role: "user", message: { content: [{ type: "text", text: "earlier" }] } },
    { role: "assistant", message: { content: [{ type: "text", text: "earlier done" }] } },
    { type: "turn_ended", status: "completed" },
    { type: "metadata", padding: "x".repeat(17 * 1024 * 1024) },
    { role: "user", message: { content: [{ type: "text", text: "target" }] } },
    { role: "assistant", message: { content: [{ type: "text", text: "target done" }] } },
    { type: "turn_ended", status: "completed" },
  ]);
  writeHookState(hookState, {
    client: "cursor", conversationId, turnId: "generation",
    startedAt: "2026-08-20T00:00:00.000Z", requestedAt: "2026-08-20T00:00:01.000Z",
  });

  const result = spawnSync(process.execPath, [
    cliPath, "turn", "analyze", "--client", "cursor", "--hook-state", hookState,
    "--session", session, "--json",
  ], { encoding: "utf8" });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /exceeds the 16 MiB bounded tail/);
});
