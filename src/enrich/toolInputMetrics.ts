export interface ToolInputStats {
  input_chars: number;
  param_count: number;
  flag_count: number;
  env_count: number;
  json_keys: number;
}

const LONG_FLAG_RE = /--[a-zA-Z][\w-]*/g;
const SHORT_FLAG_RE = /(?:^|\s)-[a-zA-Z](?=\s|$)/g;
const MAVEN_PROP_RE = /-D[\w.$]+=/g;
const ENV_ASSIGN_RE = /\b[A-Z_][A-Z0-9_]*=/g;

function countNonEmptyJsonKeys(input: Record<string, unknown>): number {
  let n = 0;
  for (const [k, v] of Object.entries(input)) {
    if (k.startsWith("_")) continue;
    if (v == null) continue;
    if (typeof v === "string" && !v.trim()) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0) continue;
    n++;
  }
  return n;
}

export function countShellInputStats(cmd: string): ToolInputStats {
  const normalized = cmd.replace(/\s+/g, " ").trim();
  const longFlags = normalized.match(LONG_FLAG_RE) ?? [];
  const shortFlags = normalized.match(SHORT_FLAG_RE) ?? [];
  const mavenProps = normalized.match(MAVEN_PROP_RE) ?? [];
  const envAssigns = normalized.match(ENV_ASSIGN_RE) ?? [];
  const flag_count = longFlags.length + shortFlags.length + mavenProps.length;
  const env_count = envAssigns.length;
  return {
    input_chars: normalized.length,
    param_count: flag_count + env_count,
    flag_count,
    env_count,
    json_keys: 0,
  };
}

export function countToolInputStats(tool: string, input: Record<string, unknown>): ToolInputStats {
  if (tool === "Shell") {
    const cmd = String(input.command ?? input.cmd ?? "");
    return countShellInputStats(cmd);
  }
  const json_keys = countNonEmptyJsonKeys(input);
  const serialized = JSON.stringify(input);
  return {
    input_chars: serialized.length,
    param_count: json_keys,
    flag_count: 0,
    env_count: 0,
    json_keys,
  };
}

export interface ToolOptimizationTier {
  level: "high" | "medium";
  reason: "input_params" | "output_tokens" | "both";
}

export function classifyToolOptimization(
  tool: string,
  paramCount: number,
  inputChars: number,
  outputTokens: number,
): ToolOptimizationTier | null {
  const isShell = tool === "Shell";
  const heavyInput = isShell
    ? paramCount >= 12 || inputChars >= 1200
    : paramCount >= 10;
  const mediumInput = isShell
    ? paramCount >= 8 || inputChars >= 600
    : paramCount >= 8;
  const heavyOutput = outputTokens >= 50_000;
  const mediumOutput = outputTokens >= 10_000;

  if ((heavyInput && (heavyOutput || mediumOutput)) || (mediumInput && heavyOutput)) {
    return { level: "high", reason: "both" };
  }
  if (heavyInput || heavyOutput) {
    return { level: "high", reason: heavyInput ? "input_params" : "output_tokens" };
  }
  if (mediumInput || mediumOutput) {
    return { level: "medium", reason: mediumInput ? "input_params" : "output_tokens" };
  }
  return null;
}
