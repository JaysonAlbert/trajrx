import type { ParsedCodexSession } from "../types/codex.js";
import type { TrajectoryIR } from "../types/index.js";

export function wallMsFromTimestamps(startedAt?: string, endedAt?: string): number | undefined {
  if (!startedAt || !endedAt) return undefined;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  const ms = end - start;
  return ms >= 0 ? ms : undefined;
}

function lastActivityMsInTurn(turn: ParsedCodexSession["turns"][number]): number | undefined {
  let last = Date.parse(turn.timestamp);
  if (!Number.isFinite(last)) return undefined;
  for (const step of turn.steps) {
    const stepTs = Date.parse(step.timestamp);
    if (Number.isFinite(stepTs)) last = Math.max(last, stepTs);
    for (const tool of step.tools) {
      const toolTs = Date.parse(tool.timestamp);
      if (Number.isFinite(toolTs)) last = Math.max(last, toolTs);
    }
  }
  return last;
}

/** Idle time waiting for the next user message (between turns). */
export function computeCodexUserIdleMs(session: ParsedCodexSession): number {
  let totalIdle = 0;
  for (let i = 1; i < session.turns.length; i++) {
    const prevLast = lastActivityMsInTurn(session.turns[i - 1]!);
    const nextUser = Date.parse(session.turns[i]!.timestamp);
    if (prevLast == null || !Number.isFinite(nextUser)) continue;
    if (nextUser > prevLast) totalIdle += nextUser - prevLast;
  }
  return totalIdle;
}

export function resolveSessionWallMs(traj: TrajectoryIR): number | undefined {
  const direct = traj.metadata.session_wall_ms;
  if (typeof direct === "number" && direct >= 0) return direct;

  const codex = traj.metadata.codex as { started_at?: string; ended_at?: string } | undefined;
  const fromCodex = wallMsFromTimestamps(codex?.started_at, codex?.ended_at);
  if (fromCodex != null) return fromCodex;

  const session = traj.metadata.session as { started_at?: string; ended_at?: string } | undefined;
  return wallMsFromTimestamps(session?.started_at, session?.ended_at);
}

export function resolveUserIdleMs(traj: TrajectoryIR): number | undefined {
  const direct = traj.metadata.user_idle_ms;
  if (typeof direct === "number" && direct >= 0) return direct;
  return undefined;
}

export function resolveSessionActiveWallMs(traj: TrajectoryIR): number | undefined {
  const direct = traj.metadata.session_active_wall_ms;
  if (typeof direct === "number" && direct >= 0) return direct;

  const gross = resolveSessionWallMs(traj);
  const idle = resolveUserIdleMs(traj);
  if (gross == null) return undefined;
  if (idle == null) return gross;
  return Math.max(0, gross - idle);
}
