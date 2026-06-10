#!/usr/bin/env node
import { flattenOnly, processFile } from "./pipeline.js";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  let input: string | undefined;
  let runName: string | undefined;
  let output: string | undefined;
  let batch = false;
  let flattenOnlyFlag = false;
  let skipJudge = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--run-name") runName = args[++i];
    else if (a === "-o" || a === "--output") output = args[++i];
    else if (a === "--batch") batch = true;
    else if (a === "--flatten-only") flattenOnlyFlag = true;
    else if (a === "--skip-judge") skipJudge = true;
    else if (!a.startsWith("-")) input = a;
  }

  return { input, runName, output, batch, flattenOnlyFlag, skipJudge };
}

function walkJsonl(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir)) {
    const p = join(dir, ent);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walkJsonl(p));
    else if (ent.endsWith(".jsonl")) out.push(p);
  }
  return out.sort();
}

const { input, runName, output, batch, flattenOnlyFlag, skipJudge } = parseArgs(process.argv);

if (!input) {
  console.log(`Usage:
  doctor <transcript.jsonl> [--run-name NAME]
  doctor <transcript.jsonl> --flatten-only [-o out.md]
  doctor <dir> --batch`);
  process.exit(1);
}

if (flattenOnlyFlag) {
  flattenOnly(input, output, runName);
  process.exit(0);
}

if (batch) {
  for (const p of walkJsonl(input)) {
    console.log(`\n>>> Processing ${p}`);
    processFile(p, undefined, skipJudge);
  }
} else {
  processFile(input, runName, skipJudge);
}
