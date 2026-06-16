import { homedir } from "node:os";
import { join } from "node:path";

/** Where analysis runs are written. Override with DOCTOR_RUNS_DIR. */
export function getRunsDir(): string {
  if (process.env.DOCTOR_RUNS_DIR) {
    return process.env.DOCTOR_RUNS_DIR;
  }
  // Global install: write under cwd by default (not into node_modules)
  if (process.env.DOCTOR_HOME) {
    return join(process.env.DOCTOR_HOME, "runs");
  }
  return join(process.cwd(), "runs");
}

/** Optional default home for config/cache (~/.doctor). */
export function getDoctorHome(): string {
  return process.env.DOCTOR_HOME ?? join(homedir(), ".doctor");
}
