import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import type { TranscriptSource } from "../config.js";
import { getCodexHome, getCursorHome } from "../config.js";

const require = createRequire(import.meta.url);

export interface SessionMatch {
  source: TranscriptSource;
  title: string;
  session_id: string;
  transcript_path: string;
  updated_at?: string;
  score: number;
  project?: string;
}

export interface SearchSessionsOptions {
  source: TranscriptSource;
  query: string;
  codexHome?: string;
  cursorHome?: string;
  cursorProject?: string;
  limit?: number;
  /** When true, only exact title matches (case-sensitive or insensitive). */
  exact?: boolean;
}

interface CodexThreadRow {
  id: string;
  title: string;
  first_user_message?: string;
  rollout_path?: string;
  updated_at_ms?: number;
}

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

function titleMatchScore(title: string, query: string, exact = false): number {
  const t = title.trim();
  const q = query.trim();
  if (!t || !q) return 0;
  if (t === q) return 100;
  const tl = t.toLowerCase();
  const ql = q.toLowerCase();
  if (tl === ql) return 95;
  if (exact) return 0;
  if (tl.includes(ql)) return 80;
  if (ql.includes(tl) && tl.length >= 8) return 70;
  return 0;
}

function walkFiles(root: string, predicate: (path: string, name: string) => boolean): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  for (const ent of readdirSync(root)) {
    const p = join(root, ent);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walkFiles(p, predicate));
    else if (predicate(p, ent)) out.push(p);
  }
  return out;
}

function findCodexRolloutPath(sessionsRoot: string, threadId: string): string | undefined {
  if (!existsSync(sessionsRoot)) return undefined;
  const suffix = `${threadId}.jsonl`;
  const hits = walkFiles(sessionsRoot, (_p, name) => name.startsWith("rollout-") && name.endsWith(suffix));
  hits.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return hits[0];
}

function findCodexStateDb(codexHome: string): string | undefined {
  if (!existsSync(codexHome)) return undefined;
  const hits = readdirSync(codexHome)
    .filter((name) => /^state_\d+\.sqlite$/.test(name))
    .map((name) => join(codexHome, name))
    .sort((a, b) => {
      const na = Number(/state_(\d+)\.sqlite$/.exec(a)?.[1] ?? 0);
      const nb = Number(/state_(\d+)\.sqlite$/.exec(b)?.[1] ?? 0);
      return nb - na;
    });
  return hits[0];
}

function codexUpdatedAtIso(updatedAtMs?: number): string | undefined {
  if (!updatedAtMs || !Number.isFinite(updatedAtMs)) return undefined;
  return new Date(updatedAtMs).toISOString();
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

function codexTitleMatchScore(
  title: string,
  firstUserMessage: string | undefined,
  query: string,
  exact = false,
): number {
  const scores = [titleMatchScore(title, query, exact)];
  if (!exact && firstUserMessage && firstUserMessage !== title) {
    scores.push(titleMatchScore(firstUserMessage, query, exact));
  }
  return Math.max(...scores);
}

function resolveCodexTranscriptPath(
  codexHome: string,
  threadId: string,
  rolloutPath?: string,
): string | undefined {
  if (rolloutPath && existsSync(rolloutPath)) return rolloutPath;
  const fromSessions = findCodexRolloutPath(join(codexHome, "sessions"), threadId);
  if (fromSessions) return fromSessions;
  return findCodexRolloutPath(join(codexHome, "archived_sessions"), threadId);
}

function codexMatchFromTitleFields(
  query: string,
  codexHome: string,
  row: { id: string; title: string; first_user_message?: string; rollout_path?: string; updated_at?: string },
  exact = false,
): SessionMatch | undefined {
  const score = codexTitleMatchScore(row.title, row.first_user_message, query, exact);
  if (score <= 0) return undefined;
  const transcript_path = resolveCodexTranscriptPath(codexHome, row.id, row.rollout_path);
  if (!transcript_path) return undefined;
  return {
    source: "codex",
    title: row.title,
    session_id: row.id,
    transcript_path,
    updated_at: row.updated_at,
    score,
  };
}

function searchCodexSessions(query: string, codexHome: string, exact = false): SessionMatch[] {
  const q = normalizeQuery(query);
  const stateDbPath = findCodexStateDb(codexHome);
  if (!stateDbPath) return [];

  const matches: SessionMatch[] = [];
  for (const row of loadCodexThreadsFromStateDb(stateDbPath)) {
    const match = codexMatchFromTitleFields(query, codexHome, {
      id: row.id,
      title: row.title,
      first_user_message: row.first_user_message,
      rollout_path: row.rollout_path,
      updated_at: codexUpdatedAtIso(row.updated_at_ms),
    }, exact);
    if (match) matches.push(match);
  }

  return sortMatches(matches, q);
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
      const parts = message?.content ?? [];
      const texts = parts
        .filter((p) => p?.type === "text" && typeof p.text === "string")
        .map((p) => p.text as string);
      if (!texts.length) continue;
      return texts.join("\n").replace(/<user_query>\s*/g, "").replace(/\s*<\/user_query>/g, "").trim();
    }
  } finally {
    rl.close();
  }
  return null;
}

function cursorProjectSlug(projectsRoot: string, transcriptPath: string): string | undefined {
  const rel = transcriptPath.slice(projectsRoot.length).replace(/^[/\\]+/, "");
  const slug = rel.split(/[/\\]/)[0];
  return slug || undefined;
}

function isCursorTranscriptPath(path: string): boolean {
  if (!path.includes("/agent-transcripts/")) return false;
  if (path.includes("/subagents/")) return false;
  if (!basename(path).endsWith(".jsonl")) return false;
  const id = basename(path, ".jsonl");
  return basename(join(path, "..")) === id;
}

async function searchCursorSessions(
  query: string,
  cursorHome: string,
  cursorProject?: string,
  exact = false,
): Promise<SessionMatch[]> {
  const q = normalizeQuery(query);
  const projectsRoot = join(cursorHome, "projects");
  if (!existsSync(projectsRoot)) return [];

  const roots = cursorProject
    ? [join(projectsRoot, cursorProject)]
    : readdirSync(projectsRoot).map((ent) => join(projectsRoot, ent)).filter((p) => statSync(p).isDirectory());

  const matches: SessionMatch[] = [];
  for (const root of roots) {
    const files = walkFiles(root, (_p, name) => name.endsWith(".jsonl"));
    for (const transcript_path of files) {
      if (!isCursorTranscriptPath(transcript_path)) continue;
      const firstUser = await extractCursorFirstUserText(transcript_path);
      if (!firstUser) continue;
      const score = titleMatchScore(firstUser, query, exact);
      if (score <= 0) continue;
      const session_id = basename(transcript_path, ".jsonl");
      const st = statSync(transcript_path);
      matches.push({
        source: "cursor",
        title: firstUser.split("\n")[0]?.slice(0, 120) || firstUser.slice(0, 120),
        session_id,
        transcript_path,
        updated_at: new Date(st.mtimeMs).toISOString(),
        score,
        project: cursorProjectSlug(projectsRoot, transcript_path),
      });
    }
  }

  return sortMatches(matches, q);
}

function sortMatches(matches: SessionMatch[], _q: string): SessionMatch[] {
  return matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const at = a.updated_at ? Date.parse(a.updated_at) : 0;
    const bt = b.updated_at ? Date.parse(b.updated_at) : 0;
    return bt - at;
  });
}

export async function searchSessionsByTitle(opts: SearchSessionsOptions): Promise<SessionMatch[]> {
  const limit = opts.limit ?? 20;
  const codexHome = opts.codexHome ?? getCodexHome();
  const cursorHome = opts.cursorHome ?? getCursorHome();

  let matches: SessionMatch[];
  if (opts.source === "codex") {
    matches = searchCodexSessions(opts.query, codexHome, opts.exact);
  } else {
    matches = await searchCursorSessions(opts.query, cursorHome, opts.cursorProject, opts.exact);
  }
  return matches.slice(0, limit);
}

export async function resolveSessionByTitle(opts: SearchSessionsOptions): Promise<SessionMatch> {
  const matches = await searchSessionsByTitle({ ...opts, limit: 10 });
  if (!matches.length) {
    const exactHint = opts.exact ? "" : " (try --exact for full-title match only)";
    throw new Error(`No ${opts.source} session matched title/query "${opts.query}"${exactHint}`);
  }
  const topScore = matches[0]!.score;
  const top = matches.filter((m) => m.score === topScore);
  if (top.length > 1) {
    const lines = top.map((m, i) =>
      `${i + 1}. ${m.title}  id=${m.session_id}  updated=${m.updated_at ?? "?"}  ${m.transcript_path}`
    );
    throw new Error(
      `Multiple ${opts.source} sessions matched "${opts.query}" (score ${topScore}). ` +
      `Pass the transcript path explicitly or narrow the query:\n${lines.join("\n")}`
    );
  }
  return matches[0]!;
}

export function formatSessionMatches(
  matches: SessionMatch[],
  query: string,
  source: TranscriptSource,
  exact = false,
): string {
  const lines = [
    `source=${source} query="${query}" exact=${exact} matches=${matches.length}`,
    "",
  ];
  if (!matches.length) {
    lines.push("(no matches)");
    return lines.join("\n");
  }
  for (const [i, m] of matches.entries()) {
    const project = m.project ? `  project=${m.project}` : "";
    lines.push(`${i + 1}. ${m.title}`);
    lines.push(`   id=${m.session_id}  score=${m.score}  updated=${m.updated_at ?? "?"}${project}`);
    lines.push(`   ${m.transcript_path}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
