import type { CodexRolloutEvent } from "../types/codex.js";
import type { CursorEvent } from "../types/index.js";

export function isCodexRolloutEvent(event: Record<string, unknown>): boolean {
  if (typeof event.type !== "string") return false;
  if (event.type === "session_meta") return true;
  if (event.type === "event_msg" || event.type === "response_item" || event.type === "turn_context") return true;
  if ("role" in event && (event.role === "user" || event.role === "assistant")) return false;
  const payload = event.payload;
  if (payload && typeof payload === "object") {
    const pt = (payload as Record<string, unknown>).type;
    if (pt === "function_call" || pt === "function_call_output" || pt === "agent_message" || pt === "user_message") {
      return true;
    }
  }
  return false;
}

export function detectTranscriptFormat(events: Array<CursorEvent | CodexRolloutEvent>): "cursor" | "codex_rollout" {
  if (!events.length) return "cursor";
  let codex = 0;
  let cursor = 0;
  for (const event of events.slice(0, 20)) {
    const raw = event as Record<string, unknown>;
    if (raw.role === "user" || raw.role === "assistant") cursor++;
    if (isCodexRolloutEvent(raw)) codex++;
  }
  return codex > cursor ? "codex_rollout" : "cursor";
}
