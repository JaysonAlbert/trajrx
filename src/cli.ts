#!/usr/bin/env node
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentCliId } from "./agentCli/types.js";
import { isAgentEvalEnabled } from "./config.js";
import { agentEvalOnly, flattenOnly, processFile, regenerateAnalysisFromRunDir } from "./pipeline.js";

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  let input: string | undefined;
  let runName: string | undefined;
  let output: string | undefined;
  let batch = false;
  let flattenOnlyFlag = false;
  let skipJudge = false;
  let analysisOnly = false;
  let agentEvalOnlyFlag = false;
  let agentEval = isAgentEvalEnabled();
  let agentCli: AgentCliId | undefined;
  let agentModel: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--run-name") runName = args[++i];
    else if (a === "-o" || a === "--output") output = args[++i];
    else if (a === "--batch") batch = true;
    else if (a === "--flatten-only") flattenOnlyFlag = true;
    else if (a === "--skip-judge") skipJudge = true;
    else if (a === "--analysis-only") analysisOnly = true;
    else if (a === "--agent-eval") agentEval = true;
    else if (a === "--skip-agent-eval") agentEval = false;
    else if (a === "--agent-eval-only") agentEvalOnlyFlag = true;
    else if (a === "--agent-cli") agentCli = args[++i] as AgentCliId;
    else if (a === "--agent-model") agentModel = args[++i];
    else if (!a.startsWith("-")) input = a;
  }

  return { input, runName, output, batch, flattenOnlyFlag, skipJudge, analysisOnly, agentEvalOnlyFlag, agentEval, agentCli, agentModel };
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

function isRunDir(path: string): boolean {
  return existsSync(join(path, "trajectory_ir.json")) && existsSync(join(path, "judge_output", "attribution.json"));
}

async function main() {
  const {
    input,
    runName,
    output,
    batch,
    flattenOnlyFlag,
    skipJudge,
    analysisOnly,
    agentEvalOnlyFlag,
    agentEval,
    agentCli,
    agentModel,
  } = parseArgs(process.argv);

  if (!input) {
    console.log(`Usage:
  trajrx <transcript.jsonl> [--run-name NAME] [--agent-eval]
  trajrx <transcript.jsonl> --flatten-only [-o out.md]
  trajrx <run-dir> --analysis-only
  trajrx <run-dir> --agent-eval-only [--agent-cli cursor|claude|codex] [--agent-model MODEL]
  trajrx <dir> --batch [--agent-eval]

Agent evaluation (LLM path):
  --agent-eval          Run agent CLI evaluation after rule pipeline
  --skip-agent-eval     Disable (default unless TRAJRX_AGENT_EVAL=1)
  --agent-eval-only     Re-run LLM eval on an existing run directory
  --agent-cli           cursor (default) | claude | codex
  --agent-model         e.g. auto (cursor), sonnet (claude), o3 (codex)

Environment:
  TRAJRX_AGENT_EVAL=1   Enable --agent-eval by default
  TRAJRX_AGENT_CLI      Default agent CLI profile
  TRAJRX_AGENT_MODEL    Default model for agent CLI`);
    process.exit(1);
  }

  const processOpts = { skipJudge, agentEval, agentCli, agentModel };

  if (agentEvalOnlyFlag) {
    if (!isRunDir(input)) {
      console.error(`--agent-eval-only requires a completed run directory: ${input}`);
      process.exit(1);
    }
    await agentEvalOnly(input, processOpts);
    return;
  }

  if (analysisOnly) {
    regenerateAnalysisFromRunDir(input);
    return;
  }

  if (flattenOnlyFlag) {
    flattenOnly(input, output, runName);
    return;
  }

  if (batch) {
    for (const p of walkJsonl(input)) {
      console.log(`\n>>> Processing ${p}`);
      await processFile(p, undefined, processOpts);
    }
    return;
  }

  await processFile(input, runName, processOpts);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
