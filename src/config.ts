import { homedir } from "node:os";
import { join } from "node:path";

export type TranscriptSource = "codex" | "cursor";

/** Where analysis runs are written. Override with TRAJRX_RUNS_DIR. */
export function getRunsDir(): string {
  if (process.env.TRAJRX_RUNS_DIR) {
    return process.env.TRAJRX_RUNS_DIR;
  }
  // Global install: write under cwd by default (not into node_modules)
  if (process.env.TRAJRX_HOME) {
    return join(process.env.TRAJRX_HOME, "runs");
  }
  return join(process.cwd(), "runs");
}

/** Optional default home for config/cache (~/.trajrx). */
export function getTrajrxHome(): string {
  return process.env.TRAJRX_HOME ?? join(homedir(), ".trajrx");
}

/** Enable LLM agent-evaluation stage when true (env: TRAJRX_AGENT_EVAL=1). */
export function isAgentEvalEnabled(): boolean {
  const v = process.env.TRAJRX_AGENT_EVAL?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** Codex data root (~/.codex). Override with TRAJRX_CODEX_HOME. */
export function getCodexHome(): string {
  return process.env.TRAJRX_CODEX_HOME?.trim() || join(homedir(), ".codex");
}

/** Cursor data root (~/.cursor). Override with TRAJRX_CURSOR_HOME. */
export function getCursorHome(): string {
  return process.env.TRAJRX_CURSOR_HOME?.trim() || join(homedir(), ".cursor");
}
