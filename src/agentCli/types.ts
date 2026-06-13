export type AgentCliId = "cursor" | "claude" | "codex";

export interface AgentCliProfile {
  id: AgentCliId;
  displayName: string;
  /** First resolvable binary wins. */
  binaryCandidates: string[];
  buildArgs: (opts: { model: string }) => string[];
  /** When true, prompt is written to stdin instead of appended as final arg. */
  useStdin?: boolean;
  defaultModel: string;
}

export interface AgentCliInvokeRequest {
  profileId: AgentCliId;
  prompt: string;
  model?: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface AgentCliInvokeResult {
  profileId: AgentCliId;
  binary: string;
  argv: string[];
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
}
