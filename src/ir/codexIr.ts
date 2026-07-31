import { classifyExecCommand, execCommandLabel, extractRgPattern } from "../enrich/codexToolMetrics.js";
import { flattenCodexSteps, parseCodexRollout } from "./codexParser.js";
import type { CodexRolloutEvent } from "../types/codex.js";
import type { Substep, ToolExecutionMetrics, TrajectoryIR, TrajectoryStep } from "../types/index.js";
import { validateIr } from "./schema.js";
import { applySessionWallMetrics, buildCodexSessionWallMetrics } from "./sessionMetrics.js";
import { buildStepTelemetry, extractCodexStepFields } from "./stepTelemetry.js";

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
    const toolInput: Record<string, unknown> = {
      ...tool.input,
      _codex_tool: tool.name,
      _codex_output_preview: tool.output.slice(0, 2000),
    };
    if (mapped === "Grep") {
      const pat = extractRgPattern(execCommandLabel(tool.input));
      if (pat) toolInput.pattern = pat;
    }
    if (mapped === "Read") {
      const path = classifyExecCommand(execCommandLabel(tool.input)).read_path;
      if (path) toolInput.path = path;
    }
    substeps.push({
      sub_index: subIdx,
      role: `tool:${mapped}`,
      content: JSON.stringify(tool.input).slice(0, 4000),
      tool_name: mapped,
      tool_input: toolInput,
      execution: metricsMap?.get(`${stepIndex}:t${toolIndex}`),
    });
  }
  return substeps;
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
      telemetry: buildStepTelemetry(substeps, step.user_turn, extractCodexStepFields),
      substeps,
    });
  }

  const wall = buildCodexSessionWallMetrics(session);

  const ir: TrajectoryIR = {
    trajectory_id: session.trajectory_id,
    source: "codex",
    instruction: session.instruction,
    metadata: applySessionWallMetrics({
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
    }, wall),
    steps: trajectorySteps,
  };
  validateIr(ir);
  return [ir];
}
