import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import type { TranscriptSource } from "../config.js";
import { getCodexHome, getCursorHome } from "../config.js";

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
}

interface CodexIndexEntry {
  id: string;
  thread_name: string;
  updated_at?: string;
}

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

function titleMatchScore(title: string, query: string): number {
  const t = title.trim();
  const q = query.trim();
  if (!t || !q) return 0;
  if (t === q) return 100;
  const tl = t.toLowerCase();
  const ql = q.toLowerCase();
  if (tl === ql) return 95;
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

function loadCodexIndex(indexPath: string): CodexIndexEntry[] {
  if (!existsSync(indexPath)) return [];
  const entries: CodexIndexEntry[] = [];
  for (const line of readFileSync(indexPath, "utf-8").split("\n")) {
    const ln = line.trim();
    if (!ln) continue;
    try {
      const row = JSON.parse(ln) as Record<string, unknown>;
      const id = String(row.id ?? "");
      const thread_name = String(row.thread_name ?? "");
      if (!id || !thread_name) continue;
      entries.push({
        id,
        thread_name,
        updated_at: row.updated_at ? String(row.updated_at) : undefined,
      });
    } catch {
      // skip malformed lines
    }
  }
  return entries;
}

function findCodexRolloutPath(sessionsRoot: string, threadId: string): string | undefined {
  const suffix = `${threadId}.jsonl`;
  const hits = walkFiles(sessionsRoot, (_p, name) => name.startsWith("rollout-") && name.endsWith(suffix));
  hits.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return hits[0];
}

function searchCodexSessions(query: string, codexHome: string): SessionMatch[] {
  const q = normalizeQuery(query);
  const indexPath = join(codexHome, "session_index.jsonl");
  const sessionsRoot = join(codexHome, "sessions");
  const matches: SessionMatch[] = [];

  for (const entry of loadCodexIndex(indexPath)) {
    const score = titleMatchScore(entry.thread_name, query);
    if (score <= 0) continue;
    const transcript_path = findCodexRolloutPath(sessionsRoot, entry.id);
    if (!transcript_path) continue;
    matches.push({
      source: "codex",
      title: entry.thread_name,
      session_id: entry.id,
      transcript_path,
      updated_at: entry.updated_at,
      score,
    });
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

async function searchCursorSessions(query: string, cursorHome: string, cursorProject?: string): Promise<SessionMatch[]> {
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
      const score = titleMatchScore(firstUser, query);
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
    matches = searchCodexSessions(opts.query, codexHome);
  } else {
    matches = await searchCursorSessions(opts.query, cursorHome, opts.cursorProject);
  }
  return matches.slice(0, limit);
}

export async function resolveSessionByTitle(opts: SearchSessionsOptions): Promise<SessionMatch> {
  const matches = await searchSessionsByTitle({ ...opts, limit: 10 });
  if (!matches.length) {
    throw new Error(`No ${opts.source} session matched title/query "${opts.query}"`);
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

export function formatSessionMatches(matches: SessionMatch[], query: string, source: TranscriptSource): string {
  const lines = [
    `source=${source} query="${query}" matches=${matches.length}`,
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
