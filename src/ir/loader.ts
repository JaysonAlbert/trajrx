import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import type { CursorEvent, RawTrajectory } from "../types/index.js";
import type { CodexRolloutEvent } from "../types/codex.js";
import { detectTranscriptFormat } from "./detectFormat.js";

const PREFERRED_KEYS = ["traj", "events", "messages", "trajectory", "spans"] as const;

function filenameStem(path: string): string {
  const base = basename(path);
  const ext = extname(base);
  return base.slice(0, base.length - ext.length) || "trajectory";
}

function looksLikeJsonl(raw: string): boolean {
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return false;
  try {
    for (const ln of lines.slice(0, 3)) JSON.parse(ln);
    return true;
  } catch {
    return false;
  }
}

function extractEvents(obj: Record<string, unknown>): CursorEvent[] {
  for (const k of PREFERRED_KEYS) {
    const v = obj[k];
    if (Array.isArray(v)) return v as CursorEvent[];
  }
  return [obj as unknown as CursorEvent];
}

export function loadTrajectories(path: string): RawTrajectory[] {
  const raw = readFileSync(path, "utf-8").replace(/^\uFEFF/, "").trim();
  const defaultTid = filenameStem(path);

  if (!raw) {
    return [{ trajectory_id: defaultTid, instruction: "", events: [], _source_path: path }];
  }

  if (path.endsWith(".jsonl") || looksLikeJsonl(raw)) {
    const events: Array<CursorEvent | CodexRolloutEvent> = [];
    for (const line of raw.split("\n")) {
      const ln = line.trim();
      if (!ln) continue;
      events.push(JSON.parse(ln) as CursorEvent | CodexRolloutEvent);
    }
    const format = detectTranscriptFormat(events);
    return [{
      trajectory_id: defaultTid,
      instruction: "",
      events,
      _source_path: path,
      _format: format,
    }];
  }

  const obj = JSON.parse(raw) as unknown;
  if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
    const o = obj as Record<string, unknown>;
    return [{
      trajectory_id: String(o.trajectory_id ?? defaultTid),
      instruction: String(o.instruction ?? o.task ?? ""),
      events: extractEvents(o),
      _source_path: path,
    }];
  }

  if (Array.isArray(obj)) {
    if (!obj.length) {
      return [{ trajectory_id: defaultTid, instruction: "", events: [], _source_path: path }];
    }
    const first = obj[0] as Record<string, unknown>;
    const isEvents = obj.every(
      (x) => typeof x === "object" && x !== null && !PREFERRED_KEYS.some((k) => k in (x as object))
    );
    if (isEvents) {
      return [{
        trajectory_id: defaultTid,
        instruction: "",
        events: obj as CursorEvent[],
        _source_path: path,
      }];
    }
    return obj.map((w, idx) => {
      const wr = w as Record<string, unknown>;
      return {
        trajectory_id: String(wr.trajectory_id ?? `${defaultTid}__${idx + 1}`),
        instruction: String(wr.instruction ?? wr.task ?? ""),
        events: extractEvents(wr),
        _source_path: path,
      };
    });
  }

  throw new Error(`Unrecognized file format: ${path}`);
}
