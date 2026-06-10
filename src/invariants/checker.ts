import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckerResult, TrajectoryIR, Violation } from "../types/index.js";
import { PRESET_INVARIANTS, exportStaticInvariants } from "./presets.js";

function aggregateTelemetry(traj: TrajectoryIR, steps: TrajectoryIR["steps"]) {
  const tool_names: Record<string, number> = {};
  const mcp_servers: Record<string, number> = {};
  for (const s of steps) {
    for (const n of s.telemetry.tool_names) tool_names[n] = (tool_names[n] ?? 0) + 1;
    for (const m of s.telemetry.mcp_servers) mcp_servers[m] = (mcp_servers[m] ?? 0) + 1;
  }
  return {
    step_count: steps.length,
    user_turns: traj.metadata.user_turns ?? 0,
    total_tool_calls: steps.reduce((n, s) => n + s.telemetry.tool_count, 0),
    total_mcp_calls: steps.reduce((n, s) => n + s.telemetry.mcp_count, 0),
    total_shell_calls: steps.reduce((n, s) => n + s.telemetry.shell_count, 0),
    total_read_calls: steps.reduce((n, s) => n + s.telemetry.read_count, 0),
    total_grep_calls: steps.reduce((n, s) => n + s.telemetry.grep_count, 0),
    tool_breakdown: Object.fromEntries(Object.entries(tool_names).sort((a, b) => b[1] - a[1])),
    mcp_breakdown: Object.fromEntries(Object.entries(mcp_servers).sort((a, b) => b[1] - a[1])),
  };
}

export function checkTrajectory(traj: TrajectoryIR): CheckerResult {
  const steps = traj.steps ?? [];
  const violations: Violation[] = [];
  for (const inv of PRESET_INVARIANTS) {
    try {
      violations.push(...inv.check(traj, steps));
    } catch (e) {
      violations.push({
        invariant_id: inv.invariant_id,
        category: inv.category,
        step_index: 0,
        severity: "low" as const,
        message: `Invariant check error: ${e}`,
        evidence: { error: String(e) },
      });
    }
  }
  return {
    trajectory_id: traj.trajectory_id,
    violations,
    violation_count: violations.length,
    telemetry_summary: aggregateTelemetry(traj, steps),
  };
}

export function checkAll(trajectories: TrajectoryIR[]): CheckerResult[] {
  return trajectories.map(checkTrajectory);
}

export function writeCheckerResults(results: CheckerResult[], outDir: string): string {
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, "violations.json");
  writeFileSync(path, JSON.stringify(results, null, 2), "utf-8");
  writeFileSync(join(outDir, "static_invariants.json"), JSON.stringify(exportStaticInvariants(), null, 2), "utf-8");
  return path;
}
