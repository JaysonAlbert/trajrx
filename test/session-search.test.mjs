import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { searchSessionsByTitle } from "../dist/session/search.js";

function sqlString(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

test("Codex search uses the latest UI thread name from session_index.jsonl", async () => {
  const codexHome = mkdtempSync(join(tmpdir(), "trajrx-session-search-"));
  const rolloutPath = join(codexHome, "sessions", "rollout-thread-1.jsonl");
  mkdirSync(join(codexHome, "sessions"), { recursive: true });
  writeFileSync(rolloutPath, "{}\n", "utf8");

  const stateDbPath = join(codexHome, "state_1.sqlite");
  execFileSync("sqlite3", [
    stateDbPath,
    `CREATE TABLE threads (
      id TEXT,
      title TEXT,
      first_user_message TEXT,
      rollout_path TEXT,
      updated_at_ms INTEGER,
      archived INTEGER
    );
    INSERT INTO threads VALUES (
      'thread-1',
      'Original state title',
      'Original first message',
      ${sqlString(rolloutPath)},
      1785488400000,
      0
    );`,
  ]);

  writeFileSync(
    join(codexHome, "session_index.jsonl"),
    [
      JSON.stringify({ id: "thread-1", thread_name: "Current UI thread name", updated_at: "2026-07-31T11:00:00Z" }),
      "not json",
      JSON.stringify({ id: "thread-1", thread_name: "Older UI thread name", updated_at: "2026-07-31T10:00:00Z" }),
    ].join("\n"),
    "utf8",
  );

  const matches = await searchSessionsByTitle({
    source: "codex",
    query: "Current UI thread name",
    codexHome,
    exact: true,
  });

  assert.equal(matches.length, 1);
  assert.equal(matches[0].title, "Current UI thread name");
  assert.equal(matches[0].session_id, "thread-1");
  assert.equal(matches[0].score, 100);
});
