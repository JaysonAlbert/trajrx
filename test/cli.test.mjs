import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
