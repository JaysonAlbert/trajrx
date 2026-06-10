import type { RawTrajectory, Substep, TrajectoryIR, TrajectoryStep } from "../types/index.js";
import { validateIr } from "./schema.js";

const USER_QUERY_RE = /<user_query>\s*(.*?)\s*<\/user_query>/s;

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

function parseAssistantContent(contentList: NonNullable<NonNullable<RawTrajectory["events"][0]["message"]>["content"]>): Substep[] {
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
      });
    }
  }
  return substeps;
}

function stepTelemetry(substeps: Substep[], userTurn: number) {
  const tool_names: string[] = [];
  const mcp_servers: string[] = [];
  const shell_cmds: string[] = [];
  const grep_patterns: string[] = [];
  const read_paths: string[] = [];
  const skill_reads: string[] = [];

  for (const sub of substeps) {
    const role = sub.role ?? "";
    const inp = sub.tool_input ?? {};
    const name = sub.tool_name ?? "";

    if (role.startsWith("tool:")) tool_names.push(name || (role.split(":")[1] ?? ""));
    if (role.startsWith("mcp:")) mcp_servers.push(role.split(":")[1]?.split("/")[0] ?? "");

    if (name === "Shell") {
      const cmd = String(inp.command ?? "");
      if (cmd) shell_cmds.push(cmd.trim());
    } else if (name === "Grep") {
      const pat = String(inp.pattern ?? "");
      if (pat) grep_patterns.push(pat);
    } else if (name === "Read") {
      const p = String(inp.path ?? "");
      if (p) {
        read_paths.push(p);
        if (p.includes("SKILL.md") || p.includes("/skills/")) skill_reads.push(p);
      }
    }
  }

  return {
    user_turn: userTurn,
    tool_count: substeps.filter((s) => s.role.startsWith("tool:") || s.role.startsWith("mcp:")).length,
    mcp_count: mcp_servers.length,
    shell_count: shell_cmds.length,
    read_count: read_paths.length,
    grep_count: grep_patterns.length,
    assistant_chars: substeps.filter((s) => s.role === "assistant").reduce((n, s) => n + s.content.length, 0),
    tool_names,
    mcp_servers,
    shell_cmds,
    grep_patterns,
    read_paths,
    skill_reads,
  };
}

export function cursorIr(trajectories: RawTrajectory[]): TrajectoryIR[] {
  const out: TrajectoryIR[] = [];

  for (const traj of trajectories) {
    const events = traj.events ?? [];
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

      const substeps = parseAssistantContent(contentList);
      if (!substeps.length) continue;

      stepIdx++;
      steps.push({
        index: stepIdx,
        telemetry: stepTelemetry(substeps, userTurn),
        substeps,
      });
    }

    const ir: TrajectoryIR = {
      trajectory_id: traj.trajectory_id ?? "unknown",
      source: "cursor",
      instruction,
      metadata: {
        source_path: traj._source_path,
        event_count: events.length,
        step_count: steps.length,
        user_turns: userTurn,
      },
      steps,
    };
    validateIr(ir);
    out.push(ir);
  }

  return out;
}
