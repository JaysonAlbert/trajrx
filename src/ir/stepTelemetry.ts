import { classifyExecCommand, extractRgPattern } from "../enrich/codexToolMetrics.js";
import type { StepTelemetry, Substep } from "../types/index.js";

export interface TelemetryExtract {
  shell_cmds: string[];
  grep_patterns: string[];
  read_paths: string[];
  skill_reads: string[];
  mcp_servers: string[];
}

export type TelemetryExtractor = (sub: Substep) => TelemetryExtract;

const EMPTY: TelemetryExtract = {
  shell_cmds: [],
  grep_patterns: [],
  read_paths: [],
  skill_reads: [],
  mcp_servers: [],
};

export function buildStepTelemetry(
  substeps: Substep[],
  userTurn: number,
  extract: TelemetryExtractor,
): StepTelemetry {
  const tool_names: string[] = [];
  const mcp_servers: string[] = [];
  const shell_cmds: string[] = [];
  const grep_patterns: string[] = [];
  const read_paths: string[] = [];
  const skill_reads: string[] = [];
  let tool_duration_ms = 0;
  let tool_output_tokens = 0;

  for (const sub of substeps) {
    const role = sub.role ?? "";
    const name = sub.tool_name ?? "";
    const exec = sub.execution;
    const fields = extract(sub);

    if (role.startsWith("tool:")) tool_names.push(name || (role.split(":")[1] ?? ""));
    if (role.startsWith("mcp:")) mcp_servers.push(role.split(":")[1]?.split("/")[0] ?? "");
    if (exec?.duration_ms != null) tool_duration_ms += exec.duration_ms;
    tool_output_tokens += exec?.output_tokens ?? 0;

    shell_cmds.push(...fields.shell_cmds);
    grep_patterns.push(...fields.grep_patterns);
    read_paths.push(...fields.read_paths);
    skill_reads.push(...fields.skill_reads);
    for (const m of fields.mcp_servers) mcp_servers.push(m);
  }

  return {
    user_turn: userTurn,
    tool_count: substeps.filter((s) => s.role.startsWith("tool:") || s.role.startsWith("mcp:")).length,
    mcp_count: mcp_servers.length,
    shell_count: shell_cmds.length,
    read_count: read_paths.length,
    grep_count: grep_patterns.length,
    assistant_chars: substeps.filter((s) => s.role === "assistant").reduce((n, s) => n + s.content.length, 0),
    tool_duration_ms,
    tool_output_tokens,
    tool_names,
    mcp_servers,
    shell_cmds,
    grep_patterns,
    read_paths,
    skill_reads,
  };
}

export function extractCursorStepFields(sub: Substep): TelemetryExtract {
  const name = sub.tool_name ?? "";
  const inp = sub.tool_input ?? {};
  const out = { ...EMPTY, mcp_servers: [] as string[] };

  if (name === "Shell") {
    const cmd = String(inp.command ?? "");
    if (cmd) out.shell_cmds.push(cmd.trim());
  } else if (name === "Grep") {
    const pat = String(inp.pattern ?? "");
    if (pat) out.grep_patterns.push(pat);
  } else if (name === "Read") {
    const p = String(inp.path ?? "");
    if (p) {
      out.read_paths.push(p);
      if (p.includes("SKILL.md") || p.includes("/skills/")) out.skill_reads.push(p);
    }
  }

  const role = sub.role ?? "";
  if (role.startsWith("mcp:")) {
    out.mcp_servers.push(role.split(":")[1]?.split("/")[0] ?? "");
  }

  return out;
}

export function extractCodexStepFields(sub: Substep): TelemetryExtract {
  const name = sub.tool_name ?? "";
  const inp = sub.tool_input ?? {};
  const out = { ...EMPTY };

  if (name === "Shell" || inp._codex_tool === "exec_command") {
    const cmd = String(inp.cmd ?? inp.command ?? "");
    const classified = classifyExecCommand(cmd);
    if (classified.shell_cmd) out.shell_cmds.push(classified.shell_cmd);
    if (classified.grep_pattern) out.grep_patterns.push(classified.grep_pattern);
    if (classified.read_path) out.read_paths.push(classified.read_path);
    if (cmd.includes("SKILL.md") || cmd.includes("/skills/")) out.skill_reads.push(cmd);
  }
  if (name === "Grep") {
    const pat = String(inp.pattern ?? "") || extractRgPattern(String(inp.cmd ?? ""));
    if (pat) out.grep_patterns.push(pat);
  }
  if (name === "Read") {
    const p = String(inp.path ?? "");
    if (p) out.read_paths.push(p);
  }

  return out;
}
