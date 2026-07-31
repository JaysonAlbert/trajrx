import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildSessionIndex, writeSessionIndex } from "../dist/session/index.js";

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

  writeSessionIndex(first, output);
  const saved = JSON.parse(readFileSync(output, "utf-8"));
  saved.sessions[0].status = "likely_done";
  saved.sessions[0].status_reason = "preserved previous analysis";
  writeFileSync(output, JSON.stringify(saved, null, 2), "utf-8");

  const second = await buildSessionIndex({ outputPath: output, previousIndexPath: output, changedOnly: true });
  assert.equal(second.sessions.length, 1);
  assert.equal(second.sessions[0].status, "likely_done");
  assert.equal(second.sessions[0].status_reason, "preserved previous analysis");
});
