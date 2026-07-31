import { execFileSync } from "node:child_process";
import { closeSync, createReadStream, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, statSync, writeFileSync } from "node:fs";
import type { Stats } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { getCodexHome, getCursorHome, getRunsDir, getTrajrxHome, type TranscriptSource } from "../config.js";
import type { RunSummary } from "../ui/summary.js";

const require = createRequire(import.meta.url);
const SCHEMA = "trajrx_session_index_v1";

export type SessionStatus = "active" | "idle" | "likely_done" | "needs_followup" | "blocked";

export interface SessionIndexEntry {
  source: TranscriptSource;
  session_id: string;
  title: string;
  transcript_path: string;
  workspace_path?: string;
  repo_path?: string;
  branch?: string;
  worktree_path?: string;
  work_item_id?: string;
  last_updated_at: string;
  status: SessionStatus;
  confidence: number;
  status_reason: string;
  manual_override: null;
  trajrx_run_path?: string;
  artifact_paths: string[];
  handoff_paths: string[];
  resume_prompt: string;
  cache: {
    transcript_mtime_ms: number;
    transcript_size: number;
  };
}

export interface SessionIndex {
  schema: typeof SCHEMA;
  generated_at: string;
  sessions: SessionIndexEntry[];
  stats: {
    session_count: number;
    changed_count: number;
    preserved_count: number;
  };
}

export interface BuildSessionIndexOptions {
  outputPath?: string;
  previousIndexPath?: string;
  changedOnly?: boolean;
  codexHome?: string;
  cursorHome?: string;
  runsDir?: string;
}

interface ScannedSession {
  source: TranscriptSource;
  session_id: string;
  title: string;
  transcript_path: string;
  last_updated_at: string;
  workspace_path?: string;
  project?: string;
  cache: SessionIndexEntry["cache"];
}

interface CodexThreadRow {
  id: string;
  title?: string;
  first_user_message?: string;
  rollout_path?: string;
  updated_at_ms?: number;
}

interface RunRecord {
  run_dir: string;
  finished_at?: string;
  session_id?: string;
  source_transcript?: string;
  artifacts: string[];
}

export function defaultSessionIndexPath(): string {
  return process.env.TRAJRX_SESSION_INDEX?.trim() || join(getTrajrxHome(), "session-index.json");
}

export async function buildSessionIndex(opts: BuildSessionIndexOptions = {}): Promise<SessionIndex> {
  const outputPath = opts.outputPath ?? defaultSessionIndexPath();
  const previous = loadPreviousIndex(opts.previousIndexPath ?? outputPath);
  const previousByKey = new Map(previous.sessions.map((entry) => [sessionKey(entry.source, entry.session_id), entry]));
  const runs = latestRuns(opts.runsDir ?? getRunsDir());
  const scanned = [
    ...scanCodexSessions(opts.codexHome ?? getCodexHome()),
    ...(await scanCursorSessions(opts.cursorHome ?? getCursorHome())),
  ];

  let changedCount = 0;
  let preservedCount = 0;
  const sessions = scanned.map((session) => {
    const previousEntry = previousByKey.get(sessionKey(session.source, session.session_id));
    if (opts.changedOnly && previousEntry && cacheMatches(previousEntry, session)) {
      preservedCount += 1;
      return previousEntry;
    }
    changedCount += 1;
    return analyzeSession(session, runs);
  });

  sessions.sort((a, b) => Date.parse(b.last_updated_at) - Date.parse(a.last_updated_at));
  return {
    schema: SCHEMA,
    generated_at: new Date().toISOString(),
    sessions,
    stats: {
      session_count: sessions.length,
      changed_count: changedCount,
      preserved_count: preservedCount,
    },
  };
}

export function writeSessionIndex(index: SessionIndex, outputPath = defaultSessionIndexPath()): void {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(index, null, 2), "utf-8");
}

export function formatSessionIndex(index: SessionIndex, outputPath = defaultSessionIndexPath()): string {
  const lines = [
    `session_index=${outputPath}`,
    `sessions=${index.stats.session_count} changed=${index.stats.changed_count} preserved=${index.stats.preserved_count}`,
    "",
  ];
  for (const session of index.sessions.slice(0, 20)) {
    lines.push(`${session.source}:${session.session_id}  ${session.status} (${Math.round(session.confidence * 100)}%)`);
    lines.push(`  ${session.title}`);
    lines.push(`  ${session.transcript_path}`);
    if (session.trajrx_run_path) lines.push(`  run: ${session.trajrx_run_path}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function loadPreviousIndex(path: string): SessionIndex {
  if (!existsSync(path)) return emptyIndex();
  try {
    const payload = JSON.parse(readFileSync(path, "utf-8")) as Partial<SessionIndex>;
    const sessions = Array.isArray(payload.sessions)
      ? payload.sessions.filter(isSessionIndexEntry)
      : [];
    return {
      schema: SCHEMA,
      generated_at: String(payload.generated_at ?? ""),
      sessions,
      stats: {
        session_count: sessions.length,
        changed_count: 0,
        preserved_count: 0,
      },
    };
  } catch {
    return emptyIndex();
  }
}

function emptyIndex(): SessionIndex {
  return {
    schema: SCHEMA,
    generated_at: "",
    sessions: [],
    stats: { session_count: 0, changed_count: 0, preserved_count: 0 },
  };
}

function isSessionIndexEntry(value: unknown): value is SessionIndexEntry {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<SessionIndexEntry>;
  return Boolean(row.source && row.session_id && row.transcript_path && row.cache);
}

function sessionKey(source: TranscriptSource, sessionId: string): string {
  return `${source}:${sessionId}`;
}

function cacheMatches(previous: SessionIndexEntry, scanned: ScannedSession): boolean {
  return (
    previous.cache?.transcript_mtime_ms === scanned.cache.transcript_mtime_ms
    && previous.cache?.transcript_size === scanned.cache.transcript_size
  );
}

function scanCodexSessions(codexHome: string): ScannedSession[] {
  const stateDbPath = findCodexStateDb(codexHome);
  if (!stateDbPath) return [];
  const rows = loadCodexThreadsFromStateDb(stateDbPath);
  const sessions: ScannedSession[] = [];
  for (const row of rows) {
    const transcriptPath = resolveCodexTranscriptPath(codexHome, row.id, row.rollout_path);
    if (!transcriptPath) continue;
    const stat = safeStat(transcriptPath);
    if (!stat) continue;
    const metadata = readTranscriptMetadata(transcriptPath);
    sessions.push({
      source: "codex",
      session_id: row.id,
      title: row.title || row.first_user_message || row.id,
      transcript_path: transcriptPath,
      last_updated_at: codexUpdatedAtIso(row.updated_at_ms) ?? stat.mtime.toISOString(),
      workspace_path: metadata.cwd,
      cache: {
        transcript_mtime_ms: Math.round(stat.mtimeMs),
        transcript_size: stat.size,
      },
    });
  }
  return sessions;
}

function findCodexStateDb(codexHome: string): string | undefined {
  if (!existsSync(codexHome)) return undefined;
  const hits = readdirSync(codexHome)
    .filter((name) => /^state_\d+\.sqlite$/.test(name))
    .map((name) => join(codexHome, name))
    .sort((a, b) => Number(/state_(\d+)\.sqlite$/.exec(b)?.[1] ?? 0) - Number(/state_(\d+)\.sqlite$/.exec(a)?.[1] ?? 0));
  return hits[0];
}

function loadCodexThreadsFromStateDb(stateDbPath: string): CodexThreadRow[] {
  try {
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    const db = new DatabaseSync(stateDbPath, { readOnly: true });
    try {
      return db
        .prepare(
          `SELECT id, title, first_user_message, rollout_path, updated_at_ms
           FROM threads
           WHERE archived = 0`,
        )
        .all() as unknown as CodexThreadRow[];
    } finally {
      db.close();
    }
  } catch {
    try {
      const out = execFileSync(
        "sqlite3",
        [
          "-json",
          stateDbPath,
          `SELECT id, title, first_user_message, rollout_path, updated_at_ms
           FROM threads
           WHERE archived = 0`,
        ],
        { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
      );
      return JSON.parse(out || "[]") as CodexThreadRow[];
    } catch {
      return [];
    }
  }
}

function resolveCodexTranscriptPath(codexHome: string, threadId: string, rolloutPath?: string): string | undefined {
  if (rolloutPath && existsSync(rolloutPath)) return rolloutPath;
  return findCodexRolloutPath(join(codexHome, "sessions"), threadId)
    ?? findCodexRolloutPath(join(codexHome, "archived_sessions"), threadId);
}

function findCodexRolloutPath(sessionsRoot: string, threadId: string): string | undefined {
  if (!existsSync(sessionsRoot)) return undefined;
  const suffix = `${threadId}.jsonl`;
  const hits = walkFiles(sessionsRoot, (_p, name) => name.startsWith("rollout-") && name.endsWith(suffix));
  hits.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return hits[0];
}

function codexUpdatedAtIso(updatedAtMs?: number): string | undefined {
  if (!updatedAtMs || !Number.isFinite(updatedAtMs)) return undefined;
  return new Date(updatedAtMs).toISOString();
}

async function scanCursorSessions(cursorHome: string): Promise<ScannedSession[]> {
  const projectsRoot = join(cursorHome, "projects");
  if (!existsSync(projectsRoot)) return [];
  const roots = readdirSync(projectsRoot)
    .map((ent) => join(projectsRoot, ent))
    .filter((path) => safeStat(path)?.isDirectory());
  const sessions: ScannedSession[] = [];
  for (const root of roots) {
    const files = walkFiles(root, (_p, name) => name.endsWith(".jsonl"));
    for (const transcriptPath of files) {
      if (!isCursorTranscriptPath(transcriptPath)) continue;
      const stat = safeStat(transcriptPath);
      if (!stat) continue;
      const firstUser = await extractCursorFirstUserText(transcriptPath);
      if (!firstUser) continue;
      sessions.push({
        source: "cursor",
        session_id: basename(transcriptPath, ".jsonl"),
        title: firstUser.split("\n")[0]?.slice(0, 160) || firstUser.slice(0, 160),
        transcript_path: transcriptPath,
        last_updated_at: stat.mtime.toISOString(),
        project: cursorProjectSlug(projectsRoot, transcriptPath),
        cache: {
          transcript_mtime_ms: Math.round(stat.mtimeMs),
          transcript_size: stat.size,
        },
      });
    }
  }
  return sessions;
}

function walkFiles(root: string, predicate: (path: string, name: string) => boolean): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  for (const ent of readdirSync(root)) {
    const path = join(root, ent);
    const stat = safeStat(path);
    if (!stat) continue;
    if (stat.isDirectory()) out.push(...walkFiles(path, predicate));
    else if (predicate(path, ent)) out.push(path);
  }
  return out;
}

function safeStat(path: string): Stats | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

function isCursorTranscriptPath(path: string): boolean {
  if (!path.includes("/agent-transcripts/")) return false;
  if (path.includes("/subagents/")) return false;
  if (!basename(path).endsWith(".jsonl")) return false;
  const id = basename(path, ".jsonl");
  return basename(dirname(path)) === id;
}

function cursorProjectSlug(projectsRoot: string, transcriptPath: string): string | undefined {
  const rel = transcriptPath.slice(projectsRoot.length).replace(/^[/\\]+/, "");
  return rel.split(/[/\\]/)[0] || undefined;
}

async function extractCursorFirstUserText(path: string): Promise<string | null> {
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf-8" }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const ln = line.trim();
      if (!ln) continue;
      let row: Record<string, unknown>;
      try {
        row = JSON.parse(ln) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (row.role !== "user") continue;
      const message = row.message as { content?: Array<{ type?: string; text?: string }> } | undefined;
      const texts = (message?.content ?? [])
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string);
      if (!texts.length) continue;
      return texts.join("\n").replace(/<user_query>\s*/g, "").replace(/\s*<\/user_query>/g, "").trim();
    }
  } finally {
    rl.close();
  }
  return null;
}

function latestRuns(runsDir: string): Map<string, RunRecord> {
  const result = new Map<string, RunRecord>();
  if (!existsSync(runsDir)) return result;
  for (const name of readdirSync(runsDir)) {
    const runDir = join(runsDir, name);
    if (!safeStat(runDir)?.isDirectory()) continue;
    const summaryPath = join(runDir, "run-summary.json");
    if (!existsSync(summaryPath)) continue;
    try {
      const summary = JSON.parse(readFileSync(summaryPath, "utf-8")) as RunSummary;
      const record: RunRecord = {
        run_dir: runDir,
        finished_at: summary.finished_at,
        session_id: summary.session_id,
        source_transcript: summary.source_transcript,
        artifacts: summary.artifacts.map((artifact) => artifact.path),
      };
      for (const key of runKeys(record)) {
        const existing = result.get(key);
        if (!existing || compareFinishedAt(record, existing) > 0) {
          result.set(key, record);
        }
      }
    } catch {
      // Ignore malformed run summaries; session indexing should keep scanning.
    }
  }
  return result;
}

function runKeys(record: RunRecord): string[] {
  return [record.session_id, record.source_transcript].filter((value): value is string => Boolean(value));
}

function compareFinishedAt(left: RunRecord, right: RunRecord): number {
  return Date.parse(left.finished_at ?? "") - Date.parse(right.finished_at ?? "");
}

function analyzeSession(session: ScannedSession, runs: Map<string, RunRecord>): SessionIndexEntry {
  const tail = readFileTail(session.transcript_path);
  const status = inferStatus(session, tail);
  const run = runs.get(session.session_id) ?? runs.get(session.transcript_path);
  const workItemId = inferWorkItemId(session.title);
  return {
    source: session.source,
    session_id: session.session_id,
    title: session.title,
    transcript_path: session.transcript_path,
    workspace_path: session.workspace_path,
    repo_path: session.workspace_path,
    worktree_path: session.workspace_path,
    work_item_id: workItemId,
    last_updated_at: session.last_updated_at,
    status: status.status,
    confidence: status.confidence,
    status_reason: status.reason,
    manual_override: null,
    trajrx_run_path: run?.run_dir,
    artifact_paths: run?.artifacts ?? [],
    handoff_paths: [],
    resume_prompt: buildResumePrompt(session, workItemId, status.reason),
    cache: session.cache,
  };
}

function readFileTail(path: string, limit = 32 * 1024): string {
  const stat = safeStat(path);
  if (!stat || stat.size <= 0) return "";
  const fd = openSync(path, "r");
  try {
    const length = Math.min(limit, stat.size);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, stat.size - length);
    return buffer.toString("utf-8");
  } catch {
    return "";
  } finally {
    closeSync(fd);
  }
}

function readTranscriptMetadata(path: string): { cwd?: string } {
  const tail = readFileTail(path, 64 * 1024);
  for (const line of tail.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { type?: string; cwd?: string };
      if (row.type === "session_meta" && row.cwd) {
        return { cwd: row.cwd };
      }
    } catch {
      continue;
    }
  }
  return {};
}

function inferStatus(session: ScannedSession, tail: string): { status: SessionStatus; confidence: number; reason: string } {
  const text = tail.toLowerCase();
  if (/blocked|blocker|waiting for user|needs user|阻断|卡住|等待/.test(text)) {
    return { status: "blocked", confidence: 0.72, reason: "transcript tail mentions a blocker or user intervention" };
  }
  if (/still need|need to run|todo|next step|follow.?up|未完成|继续|验证/.test(text)) {
    return { status: "needs_followup", confidence: 0.68, reason: "transcript tail mentions pending follow-up or verification" };
  }
  if (/complete|completed|done|tests? pass|verification passed|merged|已完成|完成/.test(text)) {
    return { status: "likely_done", confidence: 0.64, reason: "transcript tail contains completion signals" };
  }
  const ageMs = Date.now() - Date.parse(session.last_updated_at);
  if (Number.isFinite(ageMs) && ageMs < 15 * 60 * 1000) {
    return { status: "active", confidence: 0.62, reason: "transcript was updated recently" };
  }
  return { status: "idle", confidence: 0.5, reason: "no completion or blocker signal found in cached transcript tail" };
}

function inferWorkItemId(title: string): string | undefined {
  const match = /\b([A-Z][A-Z0-9]+-\d{3,})\b/.exec(title);
  return match ? `jira:${match[1]}` : undefined;
}

function buildResumePrompt(session: ScannedSession, workItemId: string | undefined, reason: string): string {
  const target = workItemId ?? `${session.source}:${session.session_id}`;
  return `Continue ${target} from transcript ${session.transcript_path}. Last TrajRx status reason: ${reason}`;
}
