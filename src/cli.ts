#!/usr/bin/env node
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentCliId } from "./agentCli/types.js";
import { isAgentEvalEnabled, type TranscriptSource } from "./config.js";
import { agentEvalOnly, flattenOnly, processFile, regenerateAnalysisFromRunDir } from "./pipeline.js";
import { formatRunsList, listRuns } from "./runs/list.js";
import { buildSessionIndex, defaultSessionIndexPath, formatSessionIndex, writeSessionIndex } from "./session/index.js";
import { formatSessionMatches, resolveSessionByTitle, searchSessionsByTitle } from "./session/search.js";
import { getRunsDir } from "./config.js";

const USAGE = `Usage:
  trajrx <transcript.jsonl> [--run-name NAME] [--agent-eval]
  trajrx --source codex|cursor --title "会话标题" [--exact] [--run-name NAME] [--agent-eval]
  trajrx --source codex|cursor --title "会话标题" [--exact] --list-sessions
  trajrx session scan [--output PATH] [--json]
  trajrx session analyze [--changed-only] [--output PATH] [--json]
  trajrx runs list [--limit N]
  trajrx <transcript.jsonl> --flatten-only [-o out.md]
  trajrx <run-dir> --analysis-only
  trajrx <run-dir> --agent-eval-only [--agent-cli cursor|claude|codex] [--agent-model MODEL]
  trajrx <dir> --batch [--agent-eval]

Runs:
  runs list             List analysis runs under ~/.trajrx/runs (or TRAJRX_RUNS_DIR)
  --limit N             Max runs to show (default 50)

Session index:
  session scan          Scan Codex/Cursor transcripts and write session-index.json
  session analyze       Refresh session-index.json; --changed-only preserves unchanged entries
  --output PATH         Output path (default ~/.trajrx/session-index.json or TRAJRX_SESSION_INDEX)
  --json                Print the generated index JSON

Session lookup:
  --source              Transcript source when using --title: codex | cursor
  --title               Match session by title (Codex: state_*.sqlite threads; Cursor: first user message)
  --exact               Require exact title match (no substring); use with --title
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

function parseRunsListArgs(argv: string[]): { limit?: number; showHelp: boolean } {
  let limit: number | undefined;
  let showHelp = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") showHelp = true;
    else if (a === "--limit") {
      const raw = argv[++i];
      const n = Number(raw);
      if (!raw || !Number.isFinite(n) || n < 1) {
        throw new Error("--limit requires a positive number");
      }
      limit = Math.floor(n);
    } else if (a.startsWith("-")) {
      throw new Error(`Unknown option for runs list: ${a}`);
    } else {
      throw new Error(`Unexpected argument for runs list: ${a}`);
    }
  }
  return { limit, showHelp };
}

function parseSessionArgs(argv: string[]): { output?: string; changedOnly: boolean; json: boolean; showHelp: boolean } {
  let output: string | undefined;
  let changedOnly = false;
  let json = false;
  let showHelp = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") showHelp = true;
    else if (a === "--output" || a === "-o") {
      output = argv[++i];
      if (!output) throw new Error("--output requires a path");
    } else if (a === "--changed-only") changedOnly = true;
    else if (a === "--json") json = true;
    else if (a.startsWith("-")) {
      throw new Error(`Unknown option for session command: ${a}`);
    } else {
      throw new Error(`Unexpected argument for session command: ${a}`);
    }
  }
  return { output, changedOnly, json, showHelp };
}

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
  let exact = false;
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
    else if (a === "--exact") exact = true;
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
    exact,
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
  exact?: boolean,
): Promise<{ path: string; sessionTitle?: string }> {
  if (title) {
    const src = assertSource(source);
    const match = await resolveSessionByTitle({ source: src, query: title, cursorProject, exact });
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
  const argv = process.argv.slice(2);
  if (argv[0] === "session") {
    const command = argv[1];
    if (!command || command === "--help" || command === "-h") {
      console.log(USAGE);
      process.exit(command ? 0 : 1);
    }
    if (command !== "scan" && command !== "analyze") {
      console.error(`Unknown session subcommand: ${command}`);
      console.error("Try: trajrx session scan or trajrx session analyze");
      process.exit(1);
    }
    const { output, changedOnly, json, showHelp } = parseSessionArgs(argv.slice(2));
    if (showHelp) {
      console.log(USAGE);
      return;
    }
    const outputPath = output ?? defaultSessionIndexPath();
    const index = await buildSessionIndex({
      outputPath,
      previousIndexPath: command === "analyze" && changedOnly ? outputPath : undefined,
      changedOnly: command === "analyze" && changedOnly,
    });
    writeSessionIndex(index, outputPath);
    console.log(json ? JSON.stringify(index, null, 2) : formatSessionIndex(index, outputPath));
    return;
  }

  if (argv[0] === "runs") {
    if (!argv[1] || argv[1] === "list") {
      const { limit, showHelp } = parseRunsListArgs(argv.slice(argv[1] === "list" ? 2 : 1));
      if (showHelp || !argv[1]) {
        console.log(USAGE);
        process.exit(showHelp ? 0 : 1);
      }
      const runsDir = getRunsDir();
      const entries = listRuns({ runsDir, limit });
      console.log(formatRunsList(entries, runsDir));
      return;
    }
    console.error(`Unknown runs subcommand: ${argv[1]}`);
    console.error("Try: trajrx runs list");
    process.exit(1);
  }

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
    exact,
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
      const matches = await searchSessionsByTitle({ source: src, query: title, cursorProject, exact });
      console.log(formatSessionMatches(matches, title, src, exact));
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

  const resolved = await resolveInputPath(input, title, source, cursorProject, exact);

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
