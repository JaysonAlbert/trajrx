#!/usr/bin/env node
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentCliId } from "./agentCli/types.js";
import { isAgentEvalEnabled, type TranscriptSource } from "./config.js";
import { agentEvalOnly, flattenOnly, processFile, regenerateAnalysisFromRunDir } from "./pipeline.js";
import { formatSessionMatches, resolveSessionByTitle, searchSessionsByTitle } from "./session/search.js";

const USAGE = `Usage:
  trajrx <transcript.jsonl> [--run-name NAME] [--agent-eval]
  trajrx --source codex|cursor --title "会话标题" [--run-name NAME] [--agent-eval]
  trajrx --source codex|cursor --title "会话标题" --list-sessions
  trajrx <transcript.jsonl> --flatten-only [-o out.md]
  trajrx <run-dir> --analysis-only
  trajrx <run-dir> --agent-eval-only [--agent-cli cursor|claude|codex] [--agent-model MODEL]
  trajrx <dir> --batch [--agent-eval]

Session lookup:
  --source              Transcript source when using --title: codex | cursor
  --title               Match session by title (Codex: session_index thread_name; Cursor: first user message)
  --list-sessions       Print matching sessions and exit (requires --source --title)
  --cursor-project      Limit Cursor search to one project slug under ~/.cursor/projects/

Agent evaluation (LLM path):
  --agent-eval          Run agent CLI evaluation after rule pipeline
  --skip-agent-eval     Disable (default unless TRAJRX_AGENT_EVAL=1)
  --agent-eval-only     Re-run LLM eval on an existing run directory
  --agent-cli           cursor (default) | claude | codex
  --agent-model         e.g. auto (cursor), sonnet (claude), o3 (codex)
  --verbose             Mirror stage details to stdout (full log always in run.log)

Environment:
  TRAJRX_AGENT_EVAL=1   Enable --agent-eval by default
  TRAJRX_AGENT_CLI      Default agent CLI profile
  TRAJRX_AGENT_MODEL    Default model for agent CLI
  TRAJRX_CODEX_HOME     Codex data root (default ~/.codex)
  TRAJRX_CURSOR_HOME    Cursor data root (default ~/.cursor)`;

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
  let title: string | undefined;
  let source: TranscriptSource | undefined;
  let listSessions = false;
  let cursorProject: string | undefined;
  let showHelp = false;
  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help" || a === "-h") showHelp = true;
    else if (a === "--run-name") runName = args[++i];
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
    else if (a === "--title") title = args[++i];
    else if (a === "--source") source = args[++i] as TranscriptSource;
    else if (a === "--list-sessions") listSessions = true;
    else if (a === "--cursor-project") cursorProject = args[++i];
    else if (a === "--verbose") verbose = true;
    else if (!a.startsWith("-")) input = a;
  }

  return {
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
    title,
    source,
    listSessions,
    cursorProject,
    showHelp,
    verbose,
  };
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

function assertSource(source: TranscriptSource | undefined): TranscriptSource {
  if (source === "codex" || source === "cursor") return source;
  throw new Error(`--source is required with --title. Choose: codex | cursor`);
}

async function resolveInputPath(
  input: string | undefined,
  title: string | undefined,
  source: TranscriptSource | undefined,
  cursorProject?: string,
): Promise<{ path: string; sessionTitle?: string }> {
  if (title) {
    const src = assertSource(source);
    const match = await resolveSessionByTitle({ source: src, query: title, cursorProject });
    console.log(`Session  ${match.title}`);
    console.log(`Source   ${src} · ${match.session_id}`);
    console.log(`File     ${match.transcript_path}`);
    console.log("");
    return { path: match.transcript_path, sessionTitle: match.title };
  }
  if (!input) {
    throw new Error("Missing transcript path. Pass a .jsonl path or use --source with --title.");
  }
  return { path: input };
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
    title,
    source,
    listSessions,
    cursorProject,
    showHelp,
    verbose,
  } = parseArgs(process.argv);

  if (showHelp || (!input && !title)) {
    console.log(USAGE);
    process.exit(showHelp ? 0 : 1);
  }

  if (title) {
    const src = assertSource(source);
    if (listSessions) {
      const matches = await searchSessionsByTitle({ source: src, query: title, cursorProject });
      console.log(formatSessionMatches(matches, title, src));
      return;
    }
  }

  if (title && (agentEvalOnlyFlag || analysisOnly)) {
    console.error("--title cannot be used with --agent-eval-only or --analysis-only");
    process.exit(1);
  }

  const processOpts = { skipJudge, agentEval, agentCli, agentModel, verbose };

  if (agentEvalOnlyFlag) {
    if (!input) {
      console.error("--agent-eval-only requires an existing run directory path");
      process.exit(1);
    }
    if (!isRunDir(input)) {
      console.error(`--agent-eval-only requires a completed run directory: ${input}`);
      process.exit(1);
    }
    await agentEvalOnly(input, processOpts);
    return;
  }

  if (analysisOnly) {
    if (!input) {
      console.error("--analysis-only requires an existing run directory path");
      process.exit(1);
    }
    regenerateAnalysisFromRunDir(input);
    return;
  }

  const resolved = await resolveInputPath(input, title, source, cursorProject);

  if (flattenOnlyFlag) {
    flattenOnly(resolved.path, output, runName);
    return;
  }

  if (batch) {
    for (const p of walkJsonl(resolved.path)) {
      console.log(`Processing ${p}`);
      await processFile(p, undefined, processOpts);
    }
    return;
  }

  await processFile(resolved.path, runName, { ...processOpts, sessionTitle: resolved.sessionTitle });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
