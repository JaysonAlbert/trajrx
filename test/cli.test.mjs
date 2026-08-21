import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(rootDir, "dist", "cli.js");
const packageVersion = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8")).version;

for (const flag of ["-v", "--version"]) {
  test(`trajrx ${flag} prints the running package version`, () => {
    const result = spawnSync(process.execPath, [cliPath, flag], { encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `trajrx ${packageVersion}\n`);
    assert.equal(result.stderr, "");
  });
}

test("trajrx rejects an unsupported Node runtime before loading CLI dependencies", () => {
  const fakeNode18 =
    "data:text/javascript," +
    encodeURIComponent('Object.defineProperty(process.versions, "node", { value: "18.20.7" });');
  const result = spawnSync(process.execPath, ["--import", fakeNode18, cliPath, "--version"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /TrajRx requires Node\.js >=20/);
  assert.match(result.stderr, /detected v18\.20\.7/);
  assert.match(result.stderr, /Retry with:/);
  assert.match(result.stderr, /volta run --node 22\.18\.0/);
  assert.doesNotMatch(result.stderr, /styleText/);
});

test("trajrx subagents prints machine-readable Cursor evidence", () => {
  const temp = mkdtempSync(join(tmpdir(), "trajrx-cli-subagents-"));
  const sessionDir = join(temp, "cursor", "projects", "repo", "agent-transcripts", "parent");
  mkdirSync(join(sessionDir, "subagents"), { recursive: true });
  const parent = join(sessionDir, "parent.jsonl");
  writeFileSync(parent, `${JSON.stringify({ role: "user", message: { content: [] } })}\n`, "utf8");
  writeFileSync(join(sessionDir, "subagents", "child.jsonl"), `${JSON.stringify({ role: "assistant", message: { content: [] } })}\n`, "utf8");

  const result = spawnSync(process.execPath, [cliPath, "subagents", parent, "--json"], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.source, "cursor");
  assert.equal(evidence.subagent_count, 1);
  assert.equal(evidence.parent_wait_ms, null);
  assert.equal(evidence.parent_wait_count, null);
  assert.deepEqual(evidence.unavailable, ["parent_wait_ms", "parent_wait_count"]);
});

test("trajrx subagents rejects a missing transcript", () => {
  const missing = join(tmpdir(), `trajrx-missing-${process.pid}.jsonl`);
  const result = spawnSync(process.execPath, [cliPath, "subagents", missing, "--json"], { encoding: "utf8" });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /subagents transcript not found/);
});
