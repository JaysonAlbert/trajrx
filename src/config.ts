import { homedir } from "node:os";
import { join } from "node:path";

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
