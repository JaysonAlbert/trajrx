import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildSessionIndex, writeSessionIndex } from "../dist/session/index.js";
import { extractCheapSessionFeatures } from "../dist/session/features.js";

test("buildSessionIndex scans Cursor transcripts and preserves unchanged analyses", async () => {
  const root = mkdtempSync(join(tmpdir(), "trajrx-session-index-"));
  const cursorHome = join(root, "cursor");
  const codexHome = join(root, "codex");
  const trajrxHome = join(root, "trajrx-home");
  const transcriptDir = join(cursorHome, "projects", "Users-me-Projects-harness", "agent-transcripts", "cursor-thread-1");
  mkdirSync(transcriptDir, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(trajrxHome, { recursive: true });

  const transcriptPath = join(transcriptDir, "cursor-thread-1.jsonl");
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({
      role: "user",
      message: { content: [{ type: "text", text: "<user_query>ZYTGXT-100001 fix scheduler UI</user_query>" }] },
    })}\n${JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "I still need to run verification." }] } })}\n`,
    "utf-8",
  );

  process.env.TRAJRX_CURSOR_HOME = cursorHome;
  process.env.TRAJRX_CODEX_HOME = codexHome;
  process.env.TRAJRX_HOME = trajrxHome;

  const output = join(root, "session-index.json");
  const first = await buildSessionIndex({ outputPath: output });
  assert.equal(first.schema, "trajrx_session_index_v1");
  assert.equal(first.sessions.length, 1);
  assert.equal(first.sessions[0].source, "cursor");
  assert.equal(first.sessions[0].session_id, "cursor-thread-1");
  assert.equal(first.sessions[0].work_item_id, "jira:ZYTGXT-100001");
  assert.match(first.sessions[0].resume_prompt, /cursor-thread-1/);
  assert.equal(first.sessions[0].cheap_features.turns, 1);
  assert.equal(first.sessions[0].cheap_features.steps, 1);
  assert.equal(first.sessions[0].cheap_features.tool_calls, 0);
  assert.equal(first.sessions[0].cheap_features.tool_output_tokens, 0);
  assert.equal(first.sessions[0].cheap_features.compaction_count, null);

  writeSessionIndex(first, output);
  const saved = JSON.parse(readFileSync(output, "utf-8"));
  saved.sessions[0].status = "likely_done";
  saved.sessions[0].status_reason = "preserved previous analysis";
  writeFileSync(output, JSON.stringify(saved, null, 2), "utf-8");

  const second = await buildSessionIndex({ outputPath: output, previousIndexPath: output, changedOnly: true });
  assert.equal(second.sessions.length, 1);
  assert.equal(second.sessions[0].status, "likely_done");
  assert.equal(second.sessions[0].status_reason, "preserved previous analysis");
  assert.deepEqual(second.sessions[0].cheap_features, saved.sessions[0].cheap_features);
});

test("cheap session features expose explainable retry and subagent signals without inventing unavailable values", () => {
  const root = mkdtempSync(join(tmpdir(), "trajrx-session-features-"));
  const transcriptDir = join(root, "cursor", "projects", "repo", "agent-transcripts", "cursor-thread-2");
  mkdirSync(transcriptDir, { recursive: true });
  const transcriptPath = join(transcriptDir, "cursor-thread-2.jsonl");
  const rows = [
    { role: "user", message: { content: [{ type: "text", text: "Investigate a failing scheduler" }] } },
    {
      role: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Shell", input: { command: "harness scheduler status" } },
          { type: "tool_use", name: "Task", input: { description: "inspect scheduler" } },
        ],
      },
    },
    { role: "assistant", message: { content: [{ type: "tool_use", name: "Shell", input: { command: "harness scheduler status" } }] } },
    { role: "assistant", message: { content: [{ type: "tool_use", name: "Shell", input: { command: "harness scheduler status" } }] } },
  ];
  writeFileSync(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf-8");

  const features = extractCheapSessionFeatures(transcriptPath, "cursor");

  assert.equal(features.turns, 1);
  assert.equal(features.steps, 3);
  assert.equal(features.tool_calls, 4);
  assert.equal(features.subagent_count, 1);
  assert.equal(features.retry_count, 2);
  assert.equal(features.loop_signal_count, 1);
  assert.equal(features.tool_output_tokens, null);
  assert.equal(features.resume_count, null);
  assert.equal(features.compaction_count, null);
  assert.ok(features.transcript_bytes > 0);
  assert.ok(features.unavailable.includes("tool_output_tokens"));
  assert.ok(features.unavailable.includes("resume_count"));
});

test("Codex resume count ignores inherited parent session metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "trajrx-codex-session-features-"));
  const transcriptPath = join(root, "rollout-child.jsonl");
  const rows = [
    { type: "session_meta", timestamp: "2026-08-08T00:00:00Z", payload: { id: "child", thread_source: "subagent" } },
    { type: "session_meta", timestamp: "2026-08-08T00:00:01Z", payload: { id: "parent", thread_source: "user" } },
    { type: "session_meta", timestamp: "2026-08-08T00:00:02Z", payload: { id: "child", thread_source: "subagent" } },
    { type: "event_msg", timestamp: "2026-08-08T00:00:03Z", payload: { type: "user_message", message: "inspect" } },
    { type: "event_msg", timestamp: "2026-08-08T00:00:04Z", payload: { type: "agent_message", message: "working" } },
    { type: "event_msg", timestamp: "2026-08-08T00:00:05Z", payload: { type: "context_compacted" } },
  ];
  writeFileSync(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf-8");

  const features = extractCheapSessionFeatures(transcriptPath, "codex");

  assert.equal(features.resume_count, 1);
  assert.equal(features.compaction_count, 1);
  assert.ok(!features.unavailable.includes("resume_count"));
  assert.ok(!features.unavailable.includes("compaction_count"));
});
