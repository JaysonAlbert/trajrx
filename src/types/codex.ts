export interface CodexRolloutEvent {
  timestamp: string;
  type: string;
  payload?: Record<string, unknown>;
}

export interface CodexToolCall {
  call_id: string;
  name: string;
  input: Record<string, unknown>;
  output: string;
  timestamp: string;
  session_id?: number;
}

export interface CodexStep {
  commentary: string;
  timestamp: string;
  tools: CodexToolCall[];
}

export interface CodexTurn {
  user_message: string;
  timestamp: string;
  steps: CodexStep[];
}

export interface ParsedCodexSession {
  trajectory_id: string;
  instruction: string;
  cwd?: string;
  model?: string;
  started_at?: string;
  ended_at?: string;
  turns: CodexTurn[];
  raw_event_count: number;
}

export type TranscriptFormat = "cursor" | "codex_rollout";
