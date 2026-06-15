import { classifyExecCommand, execCommandLabel } from "../enrich/codexToolMetrics.js";
import { flattenCodexSteps, parseCodexRollout } from "./codexParser.js";
import type { CodexRolloutEvent } from "../types/codex.js";
import type { Substep, ToolExecutionMetrics, TrajectoryIR, TrajectoryStep } from "../types/index.js";
import { validateIr } from "./schema.js";

function mapToolName(name: string, input: Record<string, unknown>): string {
  if (name === "exec_command") {
    const cmd = execCommandLabel(input);
    if (/^(rg|grep)\s/.test(cmd)) return "Grep";
    if (/^(sed|cat|head|tail)\s/.test(cmd)) return "Read";
    return "Shell";
  }
  if (name === "write_stdin") return "BackgroundPoll";
  return name;
}

function buildSubsteps(
  stepIndex: number,
  tools: Array<{ name: string; input: Record<string, unknown>; output: string }>,
  commentary: string,
  metricsMap?: Map<string, ToolExecutionMetrics>
): Substep[] {
  const substeps: Substep[] = [];
  let subIdx = 0;
  if (commentary.trim()) {
    subIdx++;
    substeps.push({ sub_index: subIdx, role: "assistant", content: commentary.slice(0, 8000) });
  }
  let toolIndex = 0;
  for (const tool of tools) {
    subIdx++;
    toolIndex++;
    const mapped = mapToolName(tool.name, tool.input);
    substeps.push({
      sub_index: subIdx,
      role: `tool:${mapped}`,
      content: JSON.stringify(tool.input).slice(0, 4000),
      tool_name: mapped,
      tool_input: { ...tool.input, _codex_tool: tool.name, _codex_output_preview: tool.output.slice(0, 2000) },
      execution: metricsMap?.get(`${stepIndex}:t${toolIndex}`),
    });
  }
  return substeps;
}

function stepTelemetry(substeps: Substep[], userTurn: number) {
  const tool_names: string[] = [];
  const shell_cmds: string[] = [];
  const grep_patterns: string[] = [];
  const read_paths: string[] = [];
  const skill_reads: string[] = [];
  let tool_duration_ms = 0;
  let tool_output_tokens = 0;

  for (const sub of substeps) {
    const name = sub.tool_name ?? "";
    const inp = sub.tool_input ?? {};
    const exec = sub.execution;
    if (sub.role.startsWith("tool:")) tool_names.push(name);
    if (exec?.duration_ms != null) tool_duration_ms += exec.duration_ms;
    tool_output_tokens += exec?.output_tokens ?? 0;

    if (name === "Shell" || inp._codex_tool === "exec_command") {
      const cmd = String(inp.cmd ?? inp.command ?? "");
      const classified = classifyExecCommand(cmd);
      if (classified.shell_cmd) shell_cmds.push(classified.shell_cmd);
      if (classified.grep_pattern) grep_patterns.push(classified.grep_pattern);
      if (classified.read_path) read_paths.push(classified.read_path);
      if (cmd.includes("SKILL.md") || cmd.includes("/skills/")) skill_reads.push(cmd);
    }
    if (name === "Grep") {
      const pat = String(inp.pattern ?? "");
      if (pat) grep_patterns.push(pat);
    }
    if (name === "Read") {
      const p = String(inp.path ?? "");
      if (p) read_paths.push(p);
    }
  }

  return {
    user_turn: userTurn,
    tool_count: substeps.filter((s) => s.role.startsWith("tool:")).length,
    mcp_count: 0,
    shell_count: shell_cmds.length,
    read_count: read_paths.length,
    grep_count: grep_patterns.length,
    assistant_chars: substeps.filter((s) => s.role === "assistant").reduce((n, s) => n + s.content.length, 0),
    tool_duration_ms,
    tool_output_tokens,
    tool_names,
    mcp_servers: [] as string[],
    shell_cmds,
    grep_patterns,
    read_paths,
    skill_reads,
  };
}

export function codexIr(
  events: CodexRolloutEvent[],
  trajectoryId: string,
  metricsMap?: Map<string, ToolExecutionMetrics>,
  toolEfficiency?: Record<string, unknown>
): TrajectoryIR[] {
  const session = parseCodexRollout(events, trajectoryId);
  const { userTurns, steps } = flattenCodexSteps(session);
  const trajectorySteps: TrajectoryStep[] = [];

  for (const step of steps) {
    const substeps = buildSubsteps(
      step.step_index,
      step.tools.map((t) => ({ name: t.name, input: t.input, output: t.output })),
      step.commentary,
      metricsMap
    );
    if (!substeps.length) continue;
    trajectorySteps.push({
      index: step.step_index,
      telemetry: stepTelemetry(substeps, step.user_turn),
      substeps,
    });
  }

  const ir: TrajectoryIR = {
    trajectory_id: session.trajectory_id,
    source: "codex",
    instruction: session.instruction,
    metadata: {
      event_count: session.raw_event_count,
      step_count: trajectorySteps.length,
      user_turns: userTurns,
      tool_efficiency: toolEfficiency,
      codex: {
        cwd: session.cwd,
        model: session.model,
        started_at: session.started_at,
        ended_at: session.ended_at,
      },
    },
    steps: trajectorySteps,
  };
  validateIr(ir);
  return [ir];
}
