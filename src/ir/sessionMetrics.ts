import { existsSync, statSync } from "node:fs";
import type { TerminalRecord } from "../enrich/toolMetrics.js";
import type { ParsedCodexSession } from "../types/codex.js";
import type { CursorEvent, TrajectoryIR } from "../types/index.js";

export type SessionWallSource = "event_timestamps" | "file_mtime";
export type UserIdleSource = "turn_gaps" | "terminal_gaps" | "unavailable";

export interface SessionWallMetrics {
  session_wall_ms?: number;
  session_active_wall_ms?: number;
  user_idle_ms?: number;
  session_started_at?: string;
  session_ended_at?: string;
  session_wall_source?: SessionWallSource;
  user_idle_source?: UserIdleSource;
}

export function wallMsFromTimestamps(startedAt?: string, endedAt?: string): number | undefined {
  if (!startedAt || !endedAt) return undefined;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  const ms = end - start;
  return ms >= 0 ? ms : undefined;
}

export function wallMsFromFile(sourcePath?: string): SessionWallMetrics | undefined {
  if (!sourcePath || !existsSync(sourcePath)) return undefined;
  const st = statSync(sourcePath);
  const startedMs = st.birthtimeMs > 0 ? st.birthtimeMs : st.ctimeMs;
  const endedMs = st.mtimeMs;
  if (!Number.isFinite(startedMs) || !Number.isFinite(endedMs) || endedMs < startedMs) return undefined;
  const session_wall_ms = Math.round(endedMs - startedMs);
  return {
    session_wall_ms,
    session_active_wall_ms: session_wall_ms,
    user_idle_ms: 0,
    session_started_at: new Date(startedMs).toISOString(),
    session_ended_at: new Date(endedMs).toISOString(),
    session_wall_source: "file_mtime",
    user_idle_source: "unavailable",
  };
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

export function buildCodexSessionWallMetrics(session: ParsedCodexSession): SessionWallMetrics {
  const session_wall_ms = wallMsFromTimestamps(session.started_at, session.ended_at);
  const user_idle_ms = computeCodexUserIdleMs(session);
  const session_active_wall_ms = session_wall_ms != null ? Math.max(0, session_wall_ms - user_idle_ms) : undefined;
  return {
    session_wall_ms,
    session_active_wall_ms,
    user_idle_ms,
    session_started_at: session.started_at,
    session_ended_at: session.ended_at,
    session_wall_source: "event_timestamps",
    user_idle_source: user_idle_ms > 0 ? "turn_gaps" : "turn_gaps",
  };
}

function shellCommandsInEventRange(events: CursorEvent[], start: number, end: number): string[] {
  const cmds: string[] = [];
  for (let i = start; i < end; i++) {
    const event = events[i];
    if (event?.role !== "assistant") continue;
    for (const item of event.message?.content ?? []) {
      if (item.type === "tool_use" && item.name === "Shell") {
        const cmd = String(item.input?.command ?? "").trim();
        if (cmd) cmds.push(cmd);
      }
    }
  }
  return cmds;
}

function terminalTimeMs(terminal: TerminalRecord, field: "start" | "end"): number | undefined {
  const raw = field === "start" ? terminal.started_at : terminal.ended_at;
  if (raw) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (field === "end" && terminal.elapsed_ms > 0 && terminal.started_at) {
    const start = Date.parse(terminal.started_at);
    if (Number.isFinite(start)) return start + terminal.elapsed_ms;
  }
  return undefined;
}

function matchTerminalsForCommands(cmds: string[], terminals: TerminalRecord[], used: Set<string>): TerminalRecord[] {
  const matched: TerminalRecord[] = [];
  for (const cmd of cmds) {
    const norm = cmd.replace(/\s+/g, " ").trim();
    let best: TerminalRecord | null = null;
    let bestScore = 0;
    for (const t of terminals) {
      if (used.has(t.file)) continue;
      const tn = t.command.replace(/\s+/g, " ").trim();
      if (tn === norm) {
        best = t;
        bestScore = Number.MAX_SAFE_INTEGER;
        break;
      }
      if (tn.includes(norm) || norm.includes(tn)) {
        const score = Math.min(tn.length, norm.length);
        if (score > bestScore) {
          bestScore = score;
          best = t;
        }
      }
    }
    if (best && (bestScore === Number.MAX_SAFE_INTEGER || bestScore > 40)) {
      used.add(best.file);
      matched.push(best);
    }
  }
  return matched;
}

/** Estimate user idle from gaps between terminal activity across user turns. */
export function computeCursorUserIdleMs(events: CursorEvent[], terminals: TerminalRecord[]): number {
  if (!terminals.length || events.length < 2) return 0;

  const userStarts: number[] = [];
  for (let i = 0; i < events.length; i++) {
    if (events[i]?.role === "user") userStarts.push(i);
  }
  if (userStarts.length < 2) return 0;

  const used = new Set<string>();
  let totalIdle = 0;

  for (let t = 1; t < userStarts.length; t++) {
    const prevEnd = userStarts[t]!;
    const curStart = userStarts[t]!;
    const prevStart = userStarts[t - 1]!;
    const prevCmds = shellCommandsInEventRange(events, prevStart + 1, prevEnd);
    const curCmds = shellCommandsInEventRange(events, curStart + 1, userStarts[t + 1] ?? events.length);
    const prevTerms = matchTerminalsForCommands(prevCmds, terminals, used);
    const curTerms = matchTerminalsForCommands(curCmds, terminals, used);

    let prevLast: number | undefined;
    for (const term of prevTerms) {
      const end = terminalTimeMs(term, "end");
      if (end != null) prevLast = prevLast == null ? end : Math.max(prevLast, end);
    }

    let curFirst: number | undefined;
    for (const term of curTerms) {
      const start = terminalTimeMs(term, "start");
      if (start != null) curFirst = curFirst == null ? start : Math.min(curFirst, start);
    }

    if (prevLast != null && curFirst != null && curFirst > prevLast) {
      totalIdle += curFirst - prevLast;
    }
  }

  return totalIdle;
}

export function buildCursorSessionWallMetrics(
  sourcePath: string | undefined,
  events: CursorEvent[],
  terminals: TerminalRecord[] = [],
): SessionWallMetrics {
  const fromFile = wallMsFromFile(sourcePath);
  if (!fromFile?.session_wall_ms) return fromFile ?? {};

  const user_idle_ms = terminals.length ? computeCursorUserIdleMs(events, terminals) : 0;
  const session_active_wall_ms = Math.max(0, fromFile.session_wall_ms - user_idle_ms);

  return {
    ...fromFile,
    user_idle_ms: Math.round(user_idle_ms),
    session_active_wall_ms: Math.round(session_active_wall_ms),
    user_idle_source: user_idle_ms > 0 ? "terminal_gaps" : terminals.length ? "terminal_gaps" : "unavailable",
  };
}

export function applySessionWallMetrics(
  metadata: TrajectoryIR["metadata"],
  wall: SessionWallMetrics,
): TrajectoryIR["metadata"] {
  return {
    ...metadata,
    session_wall_ms: wall.session_wall_ms,
    session_active_wall_ms: wall.session_active_wall_ms,
    user_idle_ms: wall.user_idle_ms,
    session_started_at: wall.session_started_at,
    session_ended_at: wall.session_ended_at,
    session: {
      ...(metadata.session ?? {}),
      started_at: wall.session_started_at,
      ended_at: wall.session_ended_at,
      wall_source: wall.session_wall_source,
      idle_source: wall.user_idle_source,
    },
  };
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

export function resolveSessionWallSource(traj: TrajectoryIR): SessionWallSource | undefined {
  const session = traj.metadata.session as { wall_source?: SessionWallSource } | undefined;
  return session?.wall_source;
}

export function resolveUserIdleSource(traj: TrajectoryIR): UserIdleSource | undefined {
  const session = traj.metadata.session as { idle_source?: UserIdleSource } | undefined;
  return session?.idle_source;
}
