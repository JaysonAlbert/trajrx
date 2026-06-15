import { formatDuration, formatTokenCount } from "../enrich/toolMetrics.js";
import type { CodexSessionToolStats } from "../enrich/codexToolMetrics.js";
import { execCommandLabel } from "../enrich/codexToolMetrics.js";
import { flattenCodexSteps, parseCodexRollout } from "../ir/codexParser.js";
import type { CodexRolloutEvent } from "../types/codex.js";
import type { ToolExecutionMetrics } from "../types/index.js";

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 20) + "\n\n… [truncated]";
}

function formatExecBlock(
  name: string,
  input: Record<string, unknown>,
  output: string,
  maxToolChars: number,
  exec?: ToolExecutionMetrics
): string {
  const lines: string[] = [`### Tool: \`${name}\``, ""];
  if (exec) {
    lines.push(`- **duration:** ${formatDuration(exec.duration_ms)} (${exec.duration_source})`);
    lines.push(`- **output:** ${formatTokenCount(exec.output_chars)} chars / ~${formatTokenCount(exec.output_tokens)} tokens (${exec.output_source})`);
    lines.push("");
  }
  if (name === "exec_command") {
    lines.push("", "```bash", truncate(execCommandLabel(input), maxToolChars), "```");
    if (input.workdir) lines.push(`- **workdir:** \`${input.workdir}\``);
    if (input.yield_time_ms != null) lines.push(`- **yield_time_ms:** ${input.yield_time_ms}`);
    if (output) {
      lines.push("", "```text", truncate(output, maxToolChars), "```");
    }
    return lines.join("\n");
  }
  lines.push("", "```json", truncate(JSON.stringify(input, null, 2), maxToolChars), "```");
  if (output) lines.push("", "```text", truncate(output, maxToolChars), "```");
  return lines.join("\n");
}

export interface CodexFlattenOptions {
  trajectoryId?: string;
  sourcePath?: string;
  maxToolChars?: number;
  maxAssistantChars?: number;
  toolMetrics?: Map<string, ToolExecutionMetrics>;
  sessionToolStats?: CodexSessionToolStats;
}

export function flattenCodexToMarkdown(events: CodexRolloutEvent[], opts: CodexFlattenOptions = {}): string {
  const {
    trajectoryId = "unknown",
    sourcePath = "",
    maxToolChars = 4000,
    maxAssistantChars = 8000,
    toolMetrics,
    sessionToolStats,
  } = opts;

  const session = parseCodexRollout(events, trajectoryId);
  const { userTurns, steps } = flattenCodexSteps(session);

  const parts: string[] = [
    "# Codex Session Transcript",
    "",
    "## Metadata",
    "",
    "| Field | Value |",
    "|-------|-------|",
    `| session_id | \`${session.trajectory_id}\` |`,
    `| source | codex_rollout |`,
  ];
  if (sourcePath) parts.push(`| transcript | \`${sourcePath}\` |`);
  if (session.cwd) parts.push(`| cwd | \`${session.cwd}\` |`);
  if (session.model) parts.push(`| model | \`${session.model}\` |`);
  if (session.started_at && session.ended_at) {
    const spanSec = Math.round((new Date(session.ended_at).getTime() - new Date(session.started_at).getTime()) / 1000);
    parts.push(`| session_span | ${formatDuration(spanSec * 1000)} |`);
  }
  parts.push(
    "",
    "> Flattened by **TrajRx** from Codex rollout trace. One section per user turn / assistant step.",
    ""
  );

  if (session.instruction) {
    parts.push("## Task (first user message)", "", session.instruction, "");
  }

  parts.push("## Conversation", "");

  let turnIdx = 0;
  for (const turn of session.turns) {
    turnIdx++;
    parts.push("---", "", `## User Turn ${turnIdx} (#U${turnIdx})`, "", turn.user_message || "_(empty)_", "");
    for (const step of turn.steps) {
      const flat = steps.find((s) => s.timestamp === step.timestamp && s.commentary === step.commentary);
      const stepIndex = flat?.step_index ?? 0;
      parts.push("---", "", `## Assistant Step ${stepIndex} (#S${stepIndex}, after #U${turnIdx})`, "");
      if (step.commentary) parts.push("", truncate(step.commentary, maxAssistantChars), "");
      let toolIdx = 0;
      for (const tool of step.tools) {
        toolIdx++;
        parts.push(
          "",
          formatExecBlock(tool.name, tool.input, tool.output, maxToolChars, toolMetrics?.get(`${stepIndex}:t${toolIdx}`)),
          ""
        );
      }
    }
  }

  parts.push("---", "", "## Session Stats", "", `- user_turns: ${userTurns}`, `- assistant_steps: ${steps.length}`, "");

  if (sessionToolStats) {
    parts.push("## Tool Efficiency Summary", "");
    parts.push(`- total_tool_duration: ${formatDuration(sessionToolStats.total_duration_ms)}`);
    parts.push(`- total_output_tokens: ~${formatTokenCount(sessionToolStats.total_output_tokens)}`);
    if (sessionToolStats.background_sessions.length) {
      parts.push("", "### Background exec sessions", "");
      for (const bg of sessionToolStats.background_sessions) {
        const wall = bg.aggregated_ms ?? bg.total_wall_ms;
        parts.push(`- session ${bg.session_id}: ${bg.poll_count} polls, wall ~${formatDuration(wall)}${bg.aggregated_ms ? " (aggregated)" : ""}, cmd: \`${bg.command.slice(0, 120)}\``);
      }
    }
    if (sessionToolStats.thinking_gaps_ms.length) {
      parts.push("", "### Long gaps between steps (>60s)", "");
      for (const gap of sessionToolStats.thinking_gaps_ms) {
        parts.push(`- after #S${gap.after_step}: ${formatDuration(gap.gap_ms)} — ${gap.label}`);
      }
    }
    if (sessionToolStats.slowest.length) {
      parts.push("", "### Slowest tools", "");
      for (const row of sessionToolStats.slowest.slice(0, 8)) {
        parts.push(`- #S${row.step} \`${row.tool}\`: ${formatDuration(row.duration_ms)} — \`${row.command.slice(0, 100)}\``);
      }
    }
    parts.push("");
  }

  return parts.join("\n");
}
