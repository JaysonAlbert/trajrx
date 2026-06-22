import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getRunsDir } from "../config.js";
import type { RunSummary } from "../ui/summary.js";

export interface RunListEntry {
  name: string;
  path: string;
  finished_at?: string;
  session_id?: string;
  session_title?: string;
  format?: string;
  violations?: number;
  primary_cause?: string;
  has_analysis: boolean;
  has_agent_eval: boolean;
}

export interface ListRunsOptions {
  runsDir?: string;
  limit?: number;
}

function displayPath(path: string): string {
  const home = process.env.HOME;
  if (home && path.startsWith(home)) return `~${path.slice(home.length)}`;
  return path;
}

function truncate(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function loadRunEntry(name: string, runDir: string): RunListEntry {
  const entry: RunListEntry = {
    name,
    path: runDir,
    has_analysis: existsSync(join(runDir, "analysis-report.md")),
    has_agent_eval: existsSync(join(runDir, "agent-evaluation.md")),
  };

  const summaryPath = join(runDir, "run-summary.json");
  if (existsSync(summaryPath)) {
    try {
      const s = JSON.parse(readFileSync(summaryPath, "utf-8")) as RunSummary;
      entry.finished_at = s.finished_at;
      entry.session_id = s.session_id;
      entry.session_title = s.session_title;
      entry.format = s.format;
      entry.violations = s.violations;
      entry.primary_cause = s.primary_cause;
      return entry;
    } catch {
      // fall through to legacy metadata
    }
  }

  const sourcePath = join(runDir, "source.json");
  if (existsSync(sourcePath)) {
    try {
      const src = JSON.parse(readFileSync(sourcePath, "utf-8")) as Record<string, unknown>;
      if (src.session_id) entry.session_id = String(src.session_id);
      if (src.analyzed_at) entry.finished_at = String(src.analyzed_at);
    } catch {
      // ignore malformed source.json
    }
  }

  const irPath = join(runDir, "trajectory_ir.json");
  if (existsSync(irPath)) {
    try {
      const ir = JSON.parse(readFileSync(irPath, "utf-8")) as Array<{
        trajectory_id?: string;
        instruction?: string;
        source?: string;
      }>;
      const first = ir[0];
      if (first) {
        entry.session_id = entry.session_id ?? first.trajectory_id;
        if (!entry.session_title && first.instruction) {
          entry.session_title = first.instruction;
        }
        entry.format = first.source;
      }
    } catch {
      // ignore malformed trajectory_ir.json
    }
  }

  if (!entry.finished_at) {
    try {
      entry.finished_at = statSync(runDir).mtime.toISOString();
    } catch {
      // ignore stat errors
    }
  }

  return entry;
}

export function listRuns(opts: ListRunsOptions = {}): RunListEntry[] {
  const runsDir = opts.runsDir ?? getRunsDir();
  if (!existsSync(runsDir)) return [];

  const names = readdirSync(runsDir).filter((name) => {
    const p = join(runsDir, name);
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  });

  const entries = names.map((name) => loadRunEntry(name, join(runsDir, name)));
  entries.sort((a, b) => {
    const ta = a.finished_at ? Date.parse(a.finished_at) : 0;
    const tb = b.finished_at ? Date.parse(b.finished_at) : 0;
    return tb - ta;
  });

  const limit = opts.limit ?? 50;
  return entries.slice(0, limit);
}

export function formatRunsList(entries: RunListEntry[], runsDir: string): string {
  const lines = [
    `runs_dir=${displayPath(runsDir)} count=${entries.length}`,
    "",
  ];
  if (!entries.length) {
    lines.push("(no runs)");
    return lines.join("\n");
  }

  for (const [i, e] of entries.entries()) {
    const title = e.session_title
      ? truncate(e.session_title, 60)
      : e.session_id ?? "?";
    const when = e.finished_at ? formatWhen(e.finished_at) : "?";
    const flags = [
      e.has_analysis ? "analysis" : null,
      e.has_agent_eval ? "agent-eval" : null,
      e.format,
    ].filter(Boolean).join(" · ");
    const metrics = e.violations != null
      ? e.primary_cause
        ? `${e.primary_cause} · ${e.violations} violations`
        : `${e.violations} violations`
      : null;

    lines.push(`${i + 1}. ${e.name}`);
    lines.push(`   ${title}`);
    if (metrics) lines.push(`   ${metrics}`);
    lines.push(`   ${when}${flags ? `  ${flags}` : ""}`);
    lines.push(`   ${displayPath(e.path)}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
