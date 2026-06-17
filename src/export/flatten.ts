import type { Attribution, CheckerResult, ToolExecutionMetrics, TrajectoryIR, Violation } from "../types/index.js";
import type { CursorEvent } from "../types/index.js";
import { formatDuration, formatTokenCount } from "../enrich/toolMetrics.js";
import { resolveSessionActiveWallMs, resolveSessionWallMs, resolveUserIdleMs } from "../ir/sessionMetrics.js";

const USER_QUERY_RE = /<user_query>\s*(.*?)\s*<\/user_query>/s;
const REDACTED_RE = /\[REDACTED\]/g;

function extractUserText(raw: string): string {
  const m = USER_QUERY_RE.exec(raw);
  let text = m ? m[1]! : raw;
  text = text.replace(/<image_files>[\s\S]*?<\/image_files>/g, "").replace(/\[Image\]\s*/g, "");
  return text.trim();
}

function truncate(s: string, max: number): string {
  if (max <= 0 || s.length <= max) return s;
  return s.slice(0, max - 20) + "\n\n… [truncated]";
}

function formatExecutionMetrics(exec?: ToolExecutionMetrics): string[] {
  if (!exec) return [];
  const lines: string[] = [];
  lines.push(`- **duration:** ${formatDuration(exec.duration_ms)} (${exec.duration_source})`);
  lines.push(`- **output:** ${formatTokenCount(exec.output_chars)} chars / ~${formatTokenCount(exec.output_tokens)} tokens (${exec.output_source})`);
  if (exec.output_path) lines.push(`- **output_path:** \`${exec.output_path}\``);
  return lines;
}

function formatToolBlock(name: string, inp: Record<string, unknown>, maxToolChars: number, exec?: ToolExecutionMetrics): string {
  const lines: string[] = [`### Tool: \`${name}\``, ""];
  lines.push(...formatExecutionMetrics(exec));
  if (lines.length > 2) lines.push("");

  if (name === "CallMcpTool") {
    lines.push(`- **MCP server:** \`${inp.server ?? "unknown"}\``);
    lines.push(`- **Tool:** \`${inp.toolName ?? "unknown"}\``);
    const args = inp.arguments as Record<string, unknown> | undefined;
    if (args && Object.keys(args).length) {
      lines.push("", "```json", truncate(JSON.stringify(args, null, 2), maxToolChars), "```");
    }
    return lines.join("\n");
  }

  if (name === "Shell") {
    if (inp.description) lines.push(`- ${inp.description}`);
    lines.push("", "```bash", truncate(String(inp.command ?? ""), maxToolChars), "```");
    return lines.join("\n");
  }

  if (name === "Read") {
    const extra: string[] = [];
    if (inp.offset != null) extra.push(`offset=${inp.offset}`);
    if (inp.limit != null) extra.push(`limit=${inp.limit}`);
    const suffix = extra.length ? ` (${extra.join(", ")})` : "";
    lines.push(`- **path:** \`${inp.path ?? ""}\`${suffix}`);
    return lines.join("\n");
  }

  if (name === "Grep") {
    lines.push(`- **pattern:** \`${inp.pattern ?? ""}\``);
    if (inp.path) lines.push(`- **path:** \`${inp.path}\``);
    if (inp.glob) lines.push(`- **glob:** \`${inp.glob}\``);
    return lines.join("\n");
  }

  if (name === "Write" || name === "StrReplace") {
    lines.push(`- **path:** \`${inp.path ?? ""}\``);
    return lines.join("\n");
  }

  if (name === "Glob") {
    lines.push(`- **pattern:** \`${inp.glob_pattern ?? ""}\``);
    if (inp.target_directory) lines.push(`- **dir:** \`${inp.target_directory}\``);
    return lines.join("\n");
  }

  lines.push("", "```json", truncate(JSON.stringify(inp, null, 2), maxToolChars), "```");
  return lines.join("\n");
}

export interface FlattenOptions {
  trajectoryId?: string;
  sourcePath?: string;
  maxToolChars?: number;
  maxAssistantChars?: number;
  toolMetrics?: Map<string, ToolExecutionMetrics>;
  sessionToolStats?: Record<string, unknown>;
}

export function flattenEventsToMarkdown(events: CursorEvent[], opts: FlattenOptions = {}): string {
  const {
    trajectoryId = "unknown",
    sourcePath = "",
    maxToolChars = 4000,
    maxAssistantChars = 8000,
    toolMetrics,
    sessionToolStats,
  } = opts;

  let userTurn = 0;
  let stepIdx = 0;
  let instruction = "";

  const parts: string[] = [
    "# Cursor Session Transcript",
    "",
    "## Metadata",
    "",
    "| Field | Value |",
    "|-------|-------|",
    `| session_id | \`${trajectoryId}\` |`,
  ];
  if (sourcePath) parts.push(`| source | \`${sourcePath}\` |`);
  parts.push(
    "",
    "> Flattened by **TrajRx** for AI attribution reading. Chronological, one section per user message or assistant step.",
    ""
  );

  const body: string[] = [];

  for (const event of events) {
    const role = event.role;
    const contentList = event.message?.content ?? [];

    if (role === "user") {
      userTurn++;
      const texts = contentList
        .filter((c) => c.type === "text")
        .map((c) => extractUserText(String(c.text ?? "")))
        .filter(Boolean);
      const userText = texts.join("\n\n").trim();
      if (userText && !instruction) instruction = userText.slice(0, 2000);
      body.push("---", "", `## User Turn ${userTurn} (#U${userTurn})`, "", userText || "_(empty user message)_", "");
      continue;
    }

    if (role !== "assistant") continue;

    stepIdx++;
    body.push("---", "", `## Assistant Step ${stepIdx} (#S${stepIdx}, after #U${userTurn})`, "");

    let subIdx = 0;
    for (const item of contentList) {
      if (item.type === "text") {
        const text = String(item.text ?? "").trim().replace(REDACTED_RE, "_[thinking redacted]_");
        if (text) body.push("", truncate(text, maxAssistantChars), "");
      } else if (item.type === "tool_use") {
        subIdx++;
        body.push("", formatToolBlock(
          String(item.name ?? "unknown"),
          (item.input ?? {}) as Record<string, unknown>,
          maxToolChars,
          toolMetrics?.get(`${stepIdx}:${subIdx}`)
        ), "");
      }
    }
  }

  if (instruction) {
    parts.push("## Task (first user message)", "", instruction, "");
  }
  parts.push("## Conversation", "", ...body);
  parts.push("---", "", "## Session Stats", "", `- user_turns: ${userTurn}`, `- assistant_steps: ${stepIdx}`, "");
  if (sessionToolStats) {
    parts.push("## Tool Efficiency Summary", "");
    parts.push(`- total_tool_duration: ${formatDuration(Number(sessionToolStats.total_duration_ms ?? 0))}`);
    parts.push(`- total_output_tokens: ~${formatTokenCount(Number(sessionToolStats.total_output_tokens ?? 0))}`);
    parts.push(`- total_output_chars: ${formatTokenCount(Number(sessionToolStats.total_output_chars ?? 0))}`);
    const slowest = (sessionToolStats.slowest as Array<{ step: number; sub_index: number; tool: string; duration_ms: number; output_tokens: number }>) ?? [];
    if (slowest.length) {
      parts.push("", "### Slowest tools", "");
      for (const row of slowest.slice(0, 5)) {
        parts.push(`- #S${row.step} \`${row.tool}\`: ${formatDuration(row.duration_ms)}, ~${formatTokenCount(row.output_tokens)} tokens`);
      }
    }
    const largest = (sessionToolStats.largest_outputs as Array<{ step: number; sub_index: number; tool: string; duration_ms: number; output_tokens: number }>) ?? [];
    if (largest.length) {
      parts.push("", "### Largest outputs", "");
      for (const row of largest.slice(0, 5)) {
        parts.push(`- #S${row.step} \`${row.tool}\`: ~${formatTokenCount(row.output_tokens)} tokens (${formatDuration(row.duration_ms)})`);
      }
    }
    parts.push("");
  }

  return parts.join("\n");
}

export function appendAttributionSection(flatMd: string, attribution: Attribution, violations?: Violation[]): string {
  const lines: string[] = [
    "",
    "---",
    "",
    "## Attribution Summary (TrajRx)",
    "",
    `- **primary_cause:** ${attribution.primary_cause}`,
    `- **confidence:** ${attribution.confidence}`,
    `- **critical_step:** ${attribution.critical_step}`,
    "",
  ];
  if (attribution.composite_causes?.length) {
    lines.push(`- **composite:** ${attribution.composite_causes.join(", ")}`, "");
  }
  const scores = attribution.category_scores ?? {};
  if (Object.keys(scores).length) {
    lines.push("### Category scores", "");
    for (const [cat, sc] of Object.entries(scores).sort((a, b) => b[1] - a[1])) {
      lines.push(`- ${cat}: ${sc}`);
    }
    lines.push("");
  }
  if (violations?.length) {
    lines.push("### Top violations", "");
    for (const v of violations.slice(0, 8)) {
      lines.push(`- \`[${v.severity}]\` **${v.invariant_id}** @ step ${v.step_index}: ${v.message}`);
    }
  }
  return flatMd + lines.join("\n");
}

export function buildReport(traj: TrajectoryIR, checker: CheckerResult, attr: Attribution): string {
  const tel = checker.telemetry_summary as Record<string, number | Record<string, number>>;
  const lines = [
    "# TrajRx Attribution Report",
    "",
    `**Session:** \`${traj.trajectory_id}\``,
    `**Source:** ${traj.source}`,
    "",
    "## Task",
    "",
    (traj.instruction || "(no instruction)").slice(0, 1500),
    "",
    "## Summary",
    "",
    "| Metric | Value |",
    "|--------|-------|",
    `| Primary cause | **${attr.primary_cause}** (confidence ${attr.confidence}) |`,
    `| Critical step | ${attr.critical_step} |`,
    `| Assistant steps | ${tel.step_count ?? 0} |`,
    `| User turns | ${tel.user_turns ?? 0} |`,
    resolveSessionWallMs(traj) != null ? `| Session wall time (gross) | ${formatDuration(resolveSessionWallMs(traj)!)} |` : null,
    resolveSessionActiveWallMs(traj) != null ? `| Session active wall time (net) | ${formatDuration(resolveSessionActiveWallMs(traj)!)} |` : null,
    resolveUserIdleMs(traj) != null && resolveUserIdleMs(traj)! > 0 ? `| User idle time | ${formatDuration(resolveUserIdleMs(traj)!)} |` : null,
    `| Violations | ${checker.violation_count} |`,
    "",
  ];
  if (tel.total_tool_duration_ms != null) {
    lines.push("## Tool Efficiency", "", "| Metric | Value |", "|--------|-------|");
    lines.push(`| Total tool time | ${formatDuration(Number(tel.total_tool_duration_ms))} |`);
    lines.push(`| Total output tokens | ~${formatTokenCount(Number(tel.total_output_tokens ?? 0))} |`);
    lines.push(`| Avg duration / tool | ${formatDuration(Number(tel.avg_tool_duration_ms ?? 0))} |`);
    lines.push(`| Avg output tokens / tool | ~${formatTokenCount(Math.round(Number(tel.avg_output_tokens_per_tool ?? 0)))} |`);
    lines.push("");
  }
  lines.push(
    "## Explanation",
    "",
    attr.explanation,
  );
  return lines.join("\n");
}

export function formatReconcileReport(rec: Record<string, unknown>): string {
  const lines = [
    "# Attribution Reconciliation",
    "",
    `**Verdict:** ${rec.verdict} (primary_match=${rec.primary_match})`,
    "",
    "| Method | Primary | Confidence |",
    "|--------|---------|------------|",
    `| Static | ${rec.static_primary} | ${rec.static_confidence} |`,
    `| Manual | ${rec.manual_primary} | ${rec.manual_confidence} |`,
    "",
  ];
  for (const n of (rec.notes as string[]) ?? []) lines.push(`- ${n}`);
  return lines.join("\n");
}
