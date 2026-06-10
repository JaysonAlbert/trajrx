import type { Attribution, CheckerResult, TrajectoryIR, Violation } from "../types/index.js";
import type { CursorEvent } from "../types/index.js";

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

function formatToolBlock(name: string, inp: Record<string, unknown>, maxToolChars: number): string {
  const lines: string[] = [`### Tool: \`${name}\``, ""];

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
}

export function flattenEventsToMarkdown(events: CursorEvent[], opts: FlattenOptions = {}): string {
  const {
    trajectoryId = "unknown",
    sourcePath = "",
    maxToolChars = 4000,
    maxAssistantChars = 8000,
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
    "> Flattened by **doctor** for AI attribution reading. Chronological, one section per user message or assistant step.",
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

    for (const item of contentList) {
      if (item.type === "text") {
        const text = String(item.text ?? "").trim().replace(REDACTED_RE, "_[thinking redacted]_");
        if (text) body.push("", truncate(text, maxAssistantChars), "");
      } else if (item.type === "tool_use") {
        body.push("", formatToolBlock(String(item.name ?? "unknown"), (item.input ?? {}) as Record<string, unknown>, maxToolChars), "");
      }
    }
  }

  if (instruction) {
    parts.push("## Task (first user message)", "", instruction, "");
  }
  parts.push("## Conversation", "", ...body);
  parts.push("---", "", "## Session Stats", "", `- user_turns: ${userTurn}`, `- assistant_steps: ${stepIdx}`, "");

  return parts.join("\n");
}

export function appendAttributionSection(flatMd: string, attribution: Attribution, violations?: Violation[]): string {
  const lines: string[] = [
    "",
    "---",
    "",
    "## Attribution Summary (doctor)",
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
    "# Doctor Attribution Report",
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
    `| Violations | ${checker.violation_count} |`,
    "",
    "## Explanation",
    "",
    attr.explanation,
  ];
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
