import type { CodexRolloutEvent, CodexStep, CodexToolCall, CodexTurn, ParsedCodexSession } from "../types/codex.js";

const AGENTS_MD_RE = /# AGENTS\.md|<INSTRUCTIONS>|Global Codex Instructions/i;

function payloadType(event: CodexRolloutEvent): string | undefined {
  const t = event.payload?.type;
  return typeof t === "string" ? t : undefined;
}

function payloadRecord(event: CodexRolloutEvent): Record<string, unknown> {
  return event.payload ?? {};
}

export function isSystemUserMessage(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (AGENTS_MD_RE.test(trimmed)) return true;
  if (trimmed.startsWith("# AGENTS.md instructions for")) return true;
  return false;
}

function extractUserMessage(event: CodexRolloutEvent): string | null {
  const p = payloadRecord(event);
  if (payloadType(event) !== "user_message") return null;
  const msg = p.message;
  return typeof msg === "string" ? msg.trim() : null;
}

function extractAgentMessage(event: CodexRolloutEvent): string | null {
  const p = payloadRecord(event);
  if (payloadType(event) !== "agent_message") return null;
  const msg = p.message;
  return typeof msg === "string" ? msg.trim() : null;
}

function parseFunctionCall(event: CodexRolloutEvent): CodexToolCall | null {
  const p = payloadRecord(event);
  if (payloadType(event) !== "function_call") return null;
  const name = String(p.name ?? "unknown");
  const call_id = String(p.call_id ?? "");
  if (!call_id) return null;
  let input: Record<string, unknown> = {};
  const args = p.arguments;
  if (typeof args === "string") {
    try {
      input = JSON.parse(args) as Record<string, unknown>;
    } catch {
      input = { raw: args };
    }
  } else if (args && typeof args === "object") {
    input = args as Record<string, unknown>;
  }
  const session_id = typeof input.session_id === "number" ? input.session_id : undefined;
  return { call_id, name, input, output: "", timestamp: event.timestamp, session_id };
}

function parseSessionMeta(events: CodexRolloutEvent[]): Pick<ParsedCodexSession, "trajectory_id" | "cwd" | "model"> {
  const meta = events.find((e) => e.type === "session_meta");
  const p = meta?.payload ?? {};
  const id = typeof p.id === "string" ? p.id : undefined;
  const cwd = typeof p.cwd === "string" ? p.cwd : undefined;
  const model = typeof p.model === "string" ? p.model : undefined;
  return {
    trajectory_id: id ?? "codex-session",
    cwd,
    model,
  };
}

export function parseCodexRollout(events: CodexRolloutEvent[], fallbackId = "codex-session"): ParsedCodexSession {
  const outputs = new Map<string, string>();
  for (const event of events) {
    const p = payloadRecord(event);
    if (payloadType(event) !== "function_call_output") continue;
    const call_id = String(p.call_id ?? "");
    const output = String(p.output ?? "");
    if (call_id) outputs.set(call_id, output);
  }

  const meta = parseSessionMeta(events);
  const turns: CodexTurn[] = [];
  let currentTurn: CodexTurn | null = null;
  let currentStep: CodexStep | null = null;
  let instruction = "";

  const flushStep = () => {
    if (!currentTurn || !currentStep) return;
    if (currentStep.commentary || currentStep.tools.length) {
      currentTurn.steps.push(currentStep);
    }
    currentStep = null;
  };

  const ensureTurn = (timestamp: string) => {
    if (!currentTurn) {
      currentTurn = { user_message: "", timestamp, steps: [] };
      turns.push(currentTurn);
    }
    return currentTurn;
  };

  const ensureStep = (timestamp: string, commentary = "") => {
    const turn = ensureTurn(timestamp);
    if (!currentStep) {
      currentStep = { commentary, timestamp, tools: [] };
      return currentStep;
    }
    if (commentary && !currentStep.commentary) currentStep.commentary = commentary;
    return currentStep;
  };

  for (const event of events) {
    const userMsg = extractUserMessage(event);
    if (userMsg != null) {
      if (isSystemUserMessage(userMsg)) continue;
      flushStep();
      currentTurn = { user_message: userMsg, timestamp: event.timestamp, steps: [] };
      turns.push(currentTurn);
      if (!instruction) instruction = userMsg.slice(0, 2000);
      continue;
    }

    const agentMsg = extractAgentMessage(event);
    if (agentMsg != null) {
      flushStep();
      currentStep = { commentary: agentMsg, timestamp: event.timestamp, tools: [] };
      continue;
    }

    const toolCall = parseFunctionCall(event);
    if (toolCall) {
      toolCall.output = outputs.get(toolCall.call_id) ?? "";
      const step = ensureStep(event.timestamp);
      step.tools.push(toolCall);
    }
  }

  flushStep();

  return {
    trajectory_id: meta.trajectory_id || fallbackId,
    instruction,
    cwd: meta.cwd,
    model: meta.model,
    started_at: events[0]?.timestamp,
    ended_at: events.at(-1)?.timestamp,
    turns,
    raw_event_count: events.length,
  };
}

export function flattenCodexSteps(session: ParsedCodexSession): { userTurns: number; steps: Array<CodexStep & { user_turn: number; step_index: number }> } {
  const steps: Array<CodexStep & { user_turn: number; step_index: number }> = [];
  let stepIndex = 0;
  let userTurns = 0;
  for (const turn of session.turns) {
    userTurns++;
    for (const step of turn.steps) {
      stepIndex++;
      steps.push({ ...step, user_turn: userTurns, step_index: stepIndex });
    }
  }
  return { userTurns, steps };
}
