import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { extractSubagentEfficiency } from "../dist/session/subagentEfficiency.js";
import { loadTrajectories } from "../dist/ir/loader.js";
import { resolveAdapter } from "../dist/ir/adapters/index.js";
import { buildAnalysisReport } from "../dist/export/analysisReport.js";

function writeJsonl(path, rows) {
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf-8");
}

function codexMeta(id, source = "user") {
  return {
    timestamp: "2026-08-20T00:00:00.000Z",
    type: "session_meta",
    payload: { id, session_id: id, thread_source: source },
  };
}

function childMeta(id, parentId, taskName) {
  return {
    timestamp: "2026-08-20T00:00:00.000Z",
    type: "session_meta",
    payload: {
      id,
      session_id: parentId,
      thread_source: "subagent",
      agent_path: taskName,
      agent_nickname: taskName.split("/").at(-1),
      parent_thread_id: parentId,
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: parentId,
            depth: 1,
            agent_path: taskName,
          },
        },
      },
    },
  };
}

function taskEvent(type, timestamp, fields = {}) {
  return { timestamp, type: "event_msg", payload: { type, ...fields } };
}

test("Codex subagent efficiency separates execution sum, wall union, and parent wait", () => {
  const root = mkdtempSync(join(tmpdir(), "trajrx-subagent-codex-"));
  const day = join(root, "codex", "sessions", "2026", "08", "20");
  mkdirSync(day, { recursive: true });
  const parentId = "parent-thread";
  const parentPath = join(day, `rollout-parent-${parentId}.jsonl`);
  writeJsonl(parentPath, [
    codexMeta(parentId),
    {
      timestamp: "2026-08-20T00:00:03.500Z",
      type: "response_item",
      payload: { type: "function_call", name: "wait_agent", call_id: "wait-1", arguments: "{}" },
    },
    {
      timestamp: "2026-08-20T00:00:06.500Z",
      type: "response_item",
      payload: { type: "function_call_output", call_id: "wait-1", output: "{}" },
    },
    {
      timestamp: "2026-08-20T00:00:08.500Z",
      type: "response_item",
      payload: { type: "function_call", name: "wait_agent", call_id: "wait-2", arguments: "{}" },
    },
    {
      timestamp: "2026-08-20T00:00:09.500Z",
      type: "response_item",
      payload: { type: "function_call_output", call_id: "wait-2", output: "{}" },
    },
  ]);

  writeJsonl(join(day, "rollout-child-one.jsonl"), [
    childMeta("child-one", parentId, "/root/candidate_spec_r1"),
    taskEvent("task_started", "2026-08-20T00:00:01.000Z", { turn_id: "one-a" }),
    taskEvent("task_complete", "2026-08-20T00:00:05.000Z", { turn_id: "one-a", duration_ms: 4_000 }),
    taskEvent("task_started", "2026-08-20T00:00:08.000Z", { turn_id: "one-b" }),
    taskEvent("task_complete", "2026-08-20T00:00:10.000Z", { turn_id: "one-b", duration_ms: 2_000 }),
  ]);
  writeJsonl(join(day, "rollout-child-two.jsonl"), [
    childMeta("child-two", parentId, "/root/candidate_standards_r1"),
    taskEvent("task_started", "2026-08-20T00:00:03.000Z", { turn_id: "two-a" }),
    taskEvent("task_complete", "2026-08-20T00:00:07.000Z", { turn_id: "two-a", duration_ms: 4_000 }),
  ]);

  const evidence = extractSubagentEfficiency(parentPath, "codex");

  assert.equal(evidence.schema_version, 1);
  assert.equal(evidence.source, "codex");
  assert.equal(evidence.timing_precision, "event_timestamps");
  assert.equal(evidence.subagent_count, 2);
  assert.equal(evidence.activation_count, 3);
  assert.equal(evidence.execution_sum_ms, 10_000);
  assert.equal(evidence.wall_union_ms, 8_000);
  assert.equal(evidence.parent_wait_ms, 4_000);
  assert.equal(evidence.parent_wait_count, 2);
  assert.equal(evidence.max_parallelism, 2);
  assert.deepEqual(evidence.unavailable, []);
  assert.deepEqual(
    evidence.subagents.map((child) => [child.task_name, child.activation_count, child.execution_ms]),
    [
      ["/root/candidate_spec_r1", 2, 6_000],
      ["/root/candidate_standards_r1", 1, 4_000],
    ],
  );

  const raw = loadTrajectories(parentPath);
  const adapter = resolveAdapter(raw[0]);
  const enrichment = adapter.enrich(parentPath, raw);
  const trajectory = adapter.buildIr(raw, enrichment)[0];
  assert.equal(trajectory.metadata.subagent_efficiency.execution_sum_ms, 10_000);
  const report = buildAnalysisReport({
    traj: trajectory,
    checker: { trajectory_id: parentId, violations: [], violation_count: 0, telemetry_summary: {} },
    attr: {
      trajectory_id: parentId,
      primary_cause: "none",
      confidence: 1,
      critical_step: null,
      category_scores: {},
      violations_by_category: {},
      top_violations: [],
      explanation: "No static issue.",
      recommended_actions: [],
    },
  });
  assert.match(report, /子 Agent 执行累计/);
  assert.match(report, /candidate_spec_r1/);
  assert.match(report, /执行累计会重复计算并行 Agent/);

  const scoped = extractSubagentEfficiency(parentPath, "codex", {
    startedAt: "2026-08-20T00:00:02.000Z",
    endedAt: "2026-08-20T00:00:07.500Z",
  });
  assert.deepEqual(scoped.scope, {
    started_at: "2026-08-20T00:00:02.000Z",
    ended_at: "2026-08-20T00:00:07.500Z",
  });
  assert.equal(scoped.subagent_count, 2);
  assert.equal(scoped.activation_count, 2);
  assert.equal(scoped.execution_sum_ms, 7_000);
  assert.equal(scoped.wall_union_ms, 5_000);
  assert.equal(scoped.parent_wait_ms, 3_000);
  assert.equal(scoped.parent_wait_count, 1);
  assert.equal(scoped.max_parallelism, 2);
});

test("Codex keeps incomplete activation durations unavailable instead of estimating them", () => {
  const root = mkdtempSync(join(tmpdir(), "trajrx-subagent-incomplete-"));
  const day = join(root, "codex", "sessions", "2026", "08", "20");
  mkdirSync(day, { recursive: true });
  const parentPath = join(day, "rollout-parent.jsonl");
  writeJsonl(parentPath, [codexMeta("parent")]);
  writeJsonl(join(day, "rollout-child.jsonl"), [
    childMeta("child", "parent", "/root/candidate_review_r2"),
    taskEvent("task_started", "2026-08-20T00:00:01.000Z", { turn_id: "running" }),
  ]);

  const evidence = extractSubagentEfficiency(parentPath, "codex");

  assert.equal(evidence.subagent_count, 1);
  assert.equal(evidence.activation_count, 1);
  assert.equal(evidence.execution_sum_ms, 0);
  assert.equal(evidence.wall_union_ms, 0);
  assert.equal(evidence.subagents[0].status, "incomplete");
  assert.equal(evidence.subagents[0].activations[0].duration_ms, null);
  assert.ok(evidence.unavailable.includes("incomplete_activation_duration"));
});

test("Codex counts an aborted child as observed execution and exposes the abort", () => {
  const root = mkdtempSync(join(tmpdir(), "trajrx-subagent-aborted-"));
  const day = join(root, "codex", "sessions", "2026", "08", "20");
  mkdirSync(day, { recursive: true });
  const parentPath = join(day, "rollout-parent.jsonl");
  writeJsonl(parentPath, [codexMeta("parent")]);
  writeJsonl(join(day, "rollout-child.jsonl"), [
    childMeta("child", "parent", "/root/candidate_review_r1"),
    taskEvent("task_started", "2026-08-20T00:00:01.000Z", { turn_id: "aborted" }),
    taskEvent("turn_aborted", "2026-08-20T00:00:03.500Z", { turn_id: "aborted" }),
  ]);

  const evidence = extractSubagentEfficiency(parentPath, "codex");

  assert.equal(evidence.execution_sum_ms, 2_500);
  assert.equal(evidence.wall_union_ms, 2_500);
  assert.equal(evidence.aborted_count, 1);
  assert.equal(evidence.subagents[0].status, "aborted");
  assert.equal(evidence.subagents[0].activations[0].status, "aborted");
  assert.deepEqual(evidence.unavailable, []);
});

test("Cursor uses child transcript file times and leaves parent wait unavailable", () => {
  const root = mkdtempSync(join(tmpdir(), "trajrx-subagent-cursor-"));
  const sessionDir = join(root, "cursor", "projects", "repo", "agent-transcripts", "cursor-parent");
  const childDir = join(sessionDir, "subagents");
  mkdirSync(childDir, { recursive: true });
  const parentPath = join(sessionDir, "cursor-parent.jsonl");
  const childPath = join(childDir, "cursor-child.jsonl");
  writeJsonl(parentPath, [{ role: "user", message: { content: [{ type: "text", text: "review" }] } }]);
  writeJsonl(childPath, [{ role: "assistant", message: { content: [{ type: "text", text: "done" }] } }]);
  const born = statSync(childPath).birthtimeMs;
  utimesSync(childPath, new Date(born), new Date(born + 5_000));

  const evidence = extractSubagentEfficiency(parentPath, "cursor");

  assert.equal(evidence.source, "cursor");
  assert.equal(evidence.timing_precision, "file_times");
  assert.equal(evidence.subagent_count, 1);
  assert.equal(evidence.activation_count, 1);
  assert.ok(evidence.execution_sum_ms >= 4_990 && evidence.execution_sum_ms <= 5_010);
  assert.equal(evidence.wall_union_ms, evidence.execution_sum_ms);
  assert.equal(evidence.parent_wait_ms, null);
  assert.equal(evidence.parent_wait_count, null);
  assert.equal(evidence.max_parallelism, 1);
  assert.equal(evidence.subagents[0].timing_source, "file_times");
  assert.ok(evidence.unavailable.includes("parent_wait_ms"));
  assert.ok(evidence.unavailable.includes("parent_wait_count"));
});
