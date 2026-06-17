import { detectTranscriptFormat } from "../detectFormat.js";
import type { RawTrajectory } from "../../types/index.js";
import { codexAdapter } from "./codexAdapter.js";
import { cursorAdapter } from "./cursorAdapter.js";
import type { TranscriptAdapter } from "./types.js";

export type { FlattenOptions, TranscriptAdapter, TranscriptEnrichment, TranscriptFormat } from "./types.js";

export function isCodexTrajectory(raw: RawTrajectory): boolean {
  return raw._format === "codex_rollout" || detectTranscriptFormat(raw.events) === "codex_rollout";
}

export function resolveAdapter(raw: RawTrajectory): TranscriptAdapter {
  return isCodexTrajectory(raw) ? codexAdapter : cursorAdapter;
}

export { codexAdapter, cursorAdapter };
