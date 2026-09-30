import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { analyzeTurn } from "../dist/session/turnAnalysis.js";

function analyze(outputs, top = 20, name = "functions.exec", notification = null) {
  const dir = mkdtempSync(join(tmpdir(), "trajrx-nested-"));
  const timestamp = "2026-09-30T00:00:00.000Z";
  const hook = join(dir, "hook");
  mkdirSync(hook);
  for (const [file, schema, clock] of [
    ["start", "harness_agent_hook_turn_v1", "startedWallNs"],
    ["request", "harness_agent_hook_request_v1", "requestedWallNs"],
  ]) writeFileSync(join(hook, `${file}.json`), JSON.stringify({
    schema, client: "codex", conversationId: "parent", turnId: "target", requestId: "request",
    [clock]: Date.parse(timestamp) * 1e6,
  }));
  const record = (payload) => ({ timestamp, type: "response_item", payload });
  const rows = [
    { timestamp, type: "session_meta", payload: { id: "parent" } },
    { timestamp, type: "event_msg", payload: { type: "task_started", turn_id: "target" } },
    record({ type: "message", role: "user", content: [{ text: "fixture" }] }),
    ...outputs.flatMap((output, i) => [
      record({ type: "custom_tool_call", name, call_id: String(i), input: "await tools.exec_command({cmd:\"fixture\"})" }),
      record({ type: "custom_tool_call_output", call_id: String(i), output }),
    ]),
    ...(notification ? [record({ type: "custom_tool_call_output", call_id: "0", output: notification })] : []),
    record({ type: "message", role: "assistant", phase: "final", content: [{ text: "done" }] }),
  ];
  const session = join(dir, "rollout.jsonl");
  writeFileSync(session, rows.map(JSON.stringify).join("\n"));
  try { return analyzeTurn({ client: "codex", hookStatePath: hook, sessionPath: session, top }); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
const wrapped = (value) => [{ type: "input_text", text: `Script completed\nWall time 0.1 seconds\nOutput:\n${typeof value === "string" ? value : JSON.stringify(value)}` }];

test("outer success preserves v1 counts while nonzero command and MCP failures are exposed", () => {
  const result = analyze([wrapped([
    { exit_code: 2, output: "expected RED test failure" },
    { isError: true, content: [{ type: "text", text: "failed" }], structuredContent: { isError: true } },
    { exit_code: 0, output: "{\"exit_code\":42,\"isError\":true}" },
    { isError: false, content: [] },
  ])]);
  assert.equal(result.tools.call_count, 1);
  assert.equal(result.tools.failed_count, 0);
  assert.equal(result.tools.repeated_calls.total, 0);
  const nested = result.tools.nested_execution;
  assert.ok(nested, "nested execution must be independently reported");
  assert.equal(nested.observed_result_count, 4);
  assert.equal(nested.failed_count, 2);
  assert.equal(nested.succeeded_count, 2);
  assert.equal(nested.unknown_count, 0);
  assert.deepEqual(nested.results.items.map(x => x.outcome), ["failed", "failed", "succeeded", "succeeded"]);
});

test("allSettled failures are counted once; expected and subsequently recovered failures remain unclassified", () => {
  const result = analyze([wrapped([
    { status: "fulfilled", value: { exit_code: 1, isError: true, output: "expected test failure" } },
    { status: "rejected", reason: { name: "TypeError", message: "fixture-secret-never-emit" } },
    { status: "fulfilled", value: { exit_code: 0, output: "recovered" } },
  ])], 1);
  const nested = result.tools.nested_execution;
  assert.ok(nested);
  assert.equal(nested.failed_count, 2);
  assert.equal(nested.observed_result_count, 3);
  assert.equal(nested.results.total, 3);
  assert.equal(nested.results.truncated, true);
  assert.equal(nested.results.items[0].interpretation, "unclassified");
  assert.doesNotMatch(JSON.stringify(nested), /fixture-secret-never-emit|expected test failure|recovered/);
});

test("partial, missing and malformed results are unknown and text errors do not invent counts", () => {
  const result = analyze([
    wrapped([{ exit_code: null, session_id: 12 }, { output: "no status" }, { exit_code: "2" }]),
    wrapped("{\"exit_code\":2"),
    wrapped("Traceback: TypeError: fixture\nHTTP 500: fixture\nerror: unknown command fixture"),
  ]);
  const nested = result.tools.nested_execution;
  assert.ok(nested);
  assert.equal(nested.failed_count, 0);
  assert.equal(nested.unknown_count, 3);
  assert.equal(nested.unknown_wrappers.total, 2);
  assert.deepEqual(nested.error_hints.items.map(x => x.signal), ["TypeError", "HTTP error", "unknown command"]);
});

test("exec_command and write_stdin printed command envelopes are recognized without parsing stdout", () => {
  const result = analyze([wrapped("Chunk ID: fixture\nWall time: 0.1 seconds\nProcess exited with code 7\nFinal output:\nTypeError: fixture"),
    wrapped("Process exited with code 0\nFinal output:\n{\"exit_code\":5}")]);
  const nested = result.tools.nested_execution;
  assert.ok(nested);
  assert.equal(nested.observed_result_count, 2);
  assert.equal(nested.failed_count, 1);
  assert.equal(nested.succeeded_count, 1);
});

test("separately printed JSON values and yielded exec output records are all inspected", () => {
  const outputs = [
    [{ type: "input_text", text: "Script running with cell ID fixture\nOutput:\n{\"exit_code\":1}" }],
    wrapped("{\"exit_code\":0}\n{\"isError\":true,\"content\":[]}"),
  ];
  const result = analyze(outputs);
  assert.equal(result.tools.nested_execution?.observed_result_count, 3);
  assert.equal(result.tools.nested_execution?.failed_count, 2);
});

// Desktop rollouts store the code tool as bare `exec`, unlike the UI namespace.
test("bare exec and wait names expose the same observations as their namespaced forms", () => {
  for (const name of ["exec", "wait", "functions.wait"]) {
    const result = analyze([wrapped({ exit_code: 9, output: "fixture" })], 10, name);
    assert.equal(result.tools.nested_execution?.failed_count, 1);
  }
});

test("Desktop separate header/result blocks preserve pending-session TypeError evidence", () => {
  const result = analyze([[{ type: "input_text", text: "Script completed\nWall time 10 seconds\nOutput:\n" },
    { type: "input_text", text: JSON.stringify({ session_id: 7, output: "Traceback\nTypeError: fixture" }) }]], 10, "exec");
  const nested = result.tools.nested_execution;
  assert.equal(nested.observed_result_count, 1);
  assert.equal(nested.unknown_count, 1);
  assert.equal(nested.unknown_wrappers.total, 0);
  assert.deepEqual(nested.error_hints.items, [{ parent_sequence: 1, signal: "TypeError" }]);
});

test("ordinary printed config objects and shell outer envelopes are not nested operations", () => {
  const config = analyze([wrapped({ labels: ["fixture"], value: 4 })]);
  assert.equal(config.tools.nested_execution.observed_result_count, 0);
  assert.equal(config.tools.nested_execution.unknown_wrappers.total, 1);
  const shell = analyze([{ exit_code: 3, output: "fixture" }], 10, "exec");
  assert.equal(shell.tools.failed_count, 1);
  assert.equal(shell.tools.nested_execution.observed_result_count, 0);
});

test("multiple output records matched to one wrapper do not increase outer call counts", () => {
  const result = analyze([wrapped({ exit_code: 0 })], 10, "exec", wrapped({ exit_code: 2 }));
  assert.equal(result.tools.call_count, 1);
  assert.equal(result.tools.failed_count, 0);
  assert.equal(result.tools.nested_execution.observed_result_count, 2);
  assert.equal(result.tools.nested_execution.failed_count, 1);
});
