import type { TerminalRecord } from "../enrich/toolMetrics.js";
import type { CursorEvent, RawTrajectory, Substep, TrajectoryIR, TrajectoryStep, ToolExecutionMetrics } from "../types/index.js";
import { validateIr } from "./schema.js";
import { applySessionWallMetrics, buildCursorSessionWallMetrics } from "./sessionMetrics.js";
import { buildStepTelemetry, extractCursorStepFields } from "./stepTelemetry.js";

const USER_QUERY_RE = /<user_query>\s*(.*?)\s*<\/user_query>/s;

export interface CursorIrOptions {
  terminals?: TerminalRecord[];
}

function extractUserText(content: string): string {
  const m = USER_QUERY_RE.exec(content);
  return (m ? m[1] : content).trim();
}

function toolRole(name: string, inp: Record<string, unknown>): string {
  if (name === "CallMcpTool") {
    const server = String(inp.server ?? inp.mcpServer ?? "unknown");
    const tool = String(inp.toolName ?? "");
    return `mcp:${server}${tool ? `/${tool}` : ""}`;
  }
  return `tool:${name}`;
}

function toolContent(inp: Record<string, unknown>): string {
  try {
    return JSON.stringify(inp).slice(0, 4000);
  } catch {
    return String(inp).slice(0, 4000);
  }
}

function parseAssistantContent(
  contentList: NonNullable<NonNullable<CursorEvent["message"]>["content"]>,
  stepIndex: number,
  metricsMap?: Map<string, ToolExecutionMetrics>
): Substep[] {
  const substeps: Substep[] = [];
  let subIdx = 0;
  for (const item of contentList) {
    if (item.type === "text") {
      const text = String(item.text ?? "").trim();
      if (text) {
        subIdx++;
        substeps.push({ sub_index: subIdx, role: "assistant", content: text.slice(0, 8000) });
      }
    } else if (item.type === "tool_use") {
      const name = String(item.name ?? "unknown");
      const inp = (item.input ?? {}) as Record<string, unknown>;
      subIdx++;
      substeps.push({
        sub_index: subIdx,
        role: toolRole(name, inp),
        content: toolContent(inp),
        tool_name: name,
        tool_input: inp,
        execution: metricsMap?.get(`${stepIndex}:${subIdx}`),
      });
    }
  }
  return substeps;
}

export function cursorIr(
  trajectories: RawTrajectory[],
  metricsMap?: Map<string, ToolExecutionMetrics>,
  toolEfficiency?: Record<string, unknown>,
  options: CursorIrOptions = {},
): TrajectoryIR[] {
  const out: TrajectoryIR[] = [];

  for (const traj of trajectories) {
    const events = traj.events as CursorEvent[];
    let instruction = traj.instruction ?? "";
    let userTurn = 0;
    const steps: TrajectoryStep[] = [];
    let stepIdx = 0;

    for (const event of events) {
      const role = event.role;
      const contentList = event.message?.content ?? [];

      if (role === "user") {
        userTurn++;
        for (const item of contentList) {
          if (item.type === "text") {
            const text = extractUserText(String(item.text ?? ""));
            if (text && !instruction) instruction = text.slice(0, 2000);
          }
        }
        continue;
      }

      if (role !== "assistant") continue;

      const substeps = parseAssistantContent(contentList, stepIdx, metricsMap);
      if (!substeps.length) continue;

      stepIdx++;
      steps.push({
        index: stepIdx,
        telemetry: buildStepTelemetry(substeps, userTurn, extractCursorStepFields),
        substeps,
      });
    }

    const wall = buildCursorSessionWallMetrics(traj._source_path, events, options.terminals ?? []);

    const ir: TrajectoryIR = {
      trajectory_id: traj.trajectory_id ?? "unknown",
      source: "cursor",
      instruction,
      metadata: applySessionWallMetrics({
        source_path: traj._source_path,
        event_count: events.length,
        step_count: steps.length,
        user_turns: userTurn,
        tool_efficiency: toolEfficiency,
      }, wall),
      steps,
    };
    validateIr(ir);
    out.push(ir);
  }

  return out;
}
