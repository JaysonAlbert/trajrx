import type { AgentCliId, AgentCliProfile } from "./types.js";

const cursorProfile: AgentCliProfile = {
  id: "cursor",
  displayName: "Cursor Agent",
  binaryCandidates: ["cursor-agent", "agent"],
  defaultModel: "auto",
  buildArgs: ({ model }) => ["--mode", "ask", "--model", model, "--trust", "-p"],
};

const claudeProfile: AgentCliProfile = {
  id: "claude",
  displayName: "Claude Code",
  binaryCandidates: ["claude"],
  defaultModel: "sonnet",
  buildArgs: ({ model }) => ["-p", "--output-format", "text", "--model", model],
};

const codexProfile: AgentCliProfile = {
  id: "codex",
  displayName: "Codex CLI",
  binaryCandidates: ["codex"],
  defaultModel: "o3",
  useStdin: true,
  buildArgs: ({ model }) => ["exec", "-c", `model="${model}"`],
};

const PROFILES: Record<AgentCliId, AgentCliProfile> = {
  cursor: cursorProfile,
  claude: claudeProfile,
  codex: codexProfile,
};

export function listAgentCliProfiles(): AgentCliProfile[] {
  return Object.values(PROFILES);
}

export function getAgentCliProfile(id: string): AgentCliProfile {
  const key = id as AgentCliId;
  const profile = PROFILES[key];
  if (!profile) {
    throw new Error(`Unknown agent CLI profile "${id}". Choose: ${Object.keys(PROFILES).join(", ")}`);
  }
  return profile;
}

export function resolveDefaultAgentCliId(): AgentCliId {
  const env = process.env.DOCTOR_AGENT_CLI?.trim().toLowerCase();
  if (env && env in PROFILES) return env as AgentCliId;
  return "cursor";
}

export function resolveDefaultAgentModel(profile: AgentCliProfile): string {
  return process.env.DOCTOR_AGENT_MODEL?.trim() || profile.defaultModel;
}
