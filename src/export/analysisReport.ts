import type { Attribution, CheckerResult, TrajectoryIR, ToolExecutionMetrics } from "../types/index.js";
import { formatDuration, formatTokenCount } from "../enrich/toolMetrics.js";
import { resolveSessionActiveWallMs, resolveSessionWallMs, resolveUserIdleMs } from "../ir/sessionMetrics.js";

export interface CommandCallRow {
  step: number;
  sub_index: number;
  tool: string;
  command: string;
  duration_ms: number | null;
  duration_source: string;
  output_tokens: number;
  output_chars: number;
  fingerprint: string;
}

export interface CommandAggregateRow {
  fingerprint: string;
  tool: string;
  command: string;
  count: number;
  total_duration_ms: number;
  total_output_tokens: number;
  avg_duration_ms: number;
  steps: number[];
}

function normalizeCmd(cmd: string): string {
  return cmd.replace(/\s+/g, " ").trim();
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + "...";
}

function sqlSnippet(args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  const q = args.query ?? args.sql;
  if (typeof q === "string") return truncate(normalizeCmd(q), 120);
  return truncate(JSON.stringify(args).slice(0, 120), 120);
}

export function commandFingerprint(tool: string, input: Record<string, unknown>): { fingerprint: string; command: string } {
  if (tool === "Shell") {
    const cmd = normalizeCmd(String(input.command ?? input.cmd ?? ""));
    return { fingerprint: `shell::${cmd}`, command: cmd };
  }
  if (tool === "Read") {
    const path = String(input.path ?? "");
    const extra: string[] = [];
    if (input.offset != null) extra.push(`offset=${input.offset}`);
    if (input.limit != null) extra.push(`limit=${input.limit}`);
    const suffix = extra.length ? ` (${extra.join(", ")})` : "";
    const command = `${path}${suffix}`;
    return { fingerprint: `read::${path}::${extra.join("|")}`, command };
  }
  if (tool === "Grep") {
    const pattern = String(input.pattern ?? input.cmd ?? "");
    const extracted = pattern.includes("rg") || pattern.includes("grep") ? pattern : String(input.pattern ?? "");
    const path = String(input.path ?? ".");
    const command = `pattern=\`${extracted.slice(0, 120)}\` path=\`${path}\``;
    return { fingerprint: `grep::${extracted}::${path}`, command };
  }
  if (tool === "Glob") {
    const command = `glob=\`${input.glob_pattern ?? ""}\`${input.target_directory ? ` dir=\`${input.target_directory}\`` : ""}`;
    return { fingerprint: `glob::${input.glob_pattern}::${input.target_directory ?? ""}`, command };
  }
  if (tool === "CallMcpTool") {
    const server = String(input.server ?? "unknown");
    const toolName = String(input.toolName ?? "unknown");
    const snippet = sqlSnippet(input.arguments as Record<string, unknown> | undefined);
    const command = `${server}/${toolName}${snippet ? ` — ${snippet}` : ""}`;
    return { fingerprint: `mcp::${server}::${toolName}::${snippet}`, command };
  }
  if (tool === "Write" || tool === "StrReplace") {
    const path = String(input.path ?? "");
    return { fingerprint: `${tool.toLowerCase()}::${path}`, command: path };
  }
  const command = truncate(JSON.stringify(input), 200);
  return { fingerprint: `${tool.toLowerCase()}::${command}`, command };
}

export function extractCommandCalls(traj: TrajectoryIR): CommandCallRow[] {
  const rows: CommandCallRow[] = [];
  for (const step of traj.steps) {
    for (const sub of step.substeps) {
      if (!sub.tool_name) continue;
      const inp = sub.tool_input ?? {};
      const { fingerprint, command } = commandFingerprint(sub.tool_name, inp);
      const ex = sub.execution;
      rows.push({
        step: step.index,
        sub_index: sub.sub_index,
        tool: sub.tool_name,
        command,
        duration_ms: ex?.duration_ms ?? null,
        duration_source: ex?.duration_source ?? "unknown",
        output_tokens: ex?.output_tokens ?? 0,
        output_chars: ex?.output_chars ?? 0,
        fingerprint,
      });
    }
  }
  return rows;
}

export function aggregateCommands(rows: CommandCallRow[]): CommandAggregateRow[] {
  const map = new Map<string, CommandAggregateRow>();
  for (const r of rows) {
    let agg = map.get(r.fingerprint);
    if (!agg) {
      agg = {
        fingerprint: r.fingerprint,
        tool: r.tool,
        command: r.command,
        count: 0,
        total_duration_ms: 0,
        total_output_tokens: 0,
        avg_duration_ms: 0,
        steps: [],
      };
      map.set(r.fingerprint, agg);
    }
    agg.count++;
    agg.total_duration_ms += r.duration_ms ?? 0;
    agg.total_output_tokens += r.output_tokens;
    agg.steps.push(r.step);
  }
  const out = [...map.values()];
  for (const a of out) {
    a.avg_duration_ms = a.count ? Math.round(a.total_duration_ms / a.count) : 0;
  }
  return out.sort((a, b) => b.total_duration_ms - a.total_duration_ms || b.total_output_tokens - a.total_output_tokens);
}

function mdTable(headers: string[], rows: string[][]): string {
  const lines = [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ];
  return lines.join("\n");
}

function escCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function sectionFullCommands(title: string, agg: CommandAggregateRow[], lang = "bash"): string {
  if (!agg.length) return "";
  const parts: string[] = [`### ${title}`, ""];
  agg.forEach((a, i) => {
    parts.push(
      `#### ${i + 1}. ${formatDuration(a.total_duration_ms)} ×${a.count} — #S${a.steps.slice(0, 6).join(", #S")}${a.steps.length > 6 ? "…" : ""}`,
      "",
      `- 均耗时: ${formatDuration(a.avg_duration_ms)} | 输出 tokens: ~${formatTokenCount(a.total_output_tokens)}`,
      "",
      `\`\`\`${lang}`,
      a.command,
      "```",
      ""
    );
  });
  return parts.join("\n");
}

function sectionShell(rows: CommandCallRow[]): string {
  const shells = rows.filter((r) => r.tool === "Shell");
  if (!shells.length) return "_（无 Shell 调用）_\n";
  const agg = aggregateCommands(shells);
  const parts: string[] = [
    "### 按具体命令聚合（Shell）",
    "",
    mdTable(
      ["#", "次数", "总耗时", "均耗时", "输出 tokens", "步骤", "命令摘要"],
      agg.map((a, i) => [
        String(i + 1),
        String(a.count),
        formatDuration(a.total_duration_ms),
        formatDuration(a.avg_duration_ms),
        `~${formatTokenCount(a.total_output_tokens)}`,
        `#S${a.steps.slice(0, 5).join(", #S")}${a.steps.length > 5 ? "…" : ""}`,
        escCell(truncate(a.command, 72)),
      ])
    ),
    "",
    sectionFullCommands("Shell 完整命令文本（按总耗时降序，见上表序号）", agg),
    "### 逐次调用（Shell，时间序）",
    "",
    mdTable(
      ["步骤", "耗时", "来源", "输出 tokens", "命令摘要"],
      shells.map((r) => [
        `#S${r.step}.${r.sub_index}`,
        formatDuration(r.duration_ms),
        r.duration_source,
        `~${formatTokenCount(r.output_tokens)}`,
        escCell(truncate(r.command, 100)),
      ])
    ),
    "",
  ];
  return parts.join("\n");
}

function sectionByTool(tool: string, title: string, rows: CommandCallRow[], lang = "text"): string {
  const filtered = rows.filter((r) => r.tool === tool);
  if (!filtered.length) return "";
  const agg = aggregateCommands(filtered);
  return [
    `### ${title}`,
    "",
    mdTable(
      ["#", "具体调用", "次数", "总耗时", "总输出 tokens", "步骤"],
      agg.map((a, i) => [
        String(i + 1),
        escCell(truncate(a.command, 100)),
        String(a.count),
        formatDuration(a.total_duration_ms),
        `~${formatTokenCount(a.total_output_tokens)}`,
        `#S${a.steps.slice(0, 4).join(", #S")}${a.steps.length > 4 ? "…" : ""}`,
      ])
    ),
    "",
    sectionFullCommands(`${title} — 完整文本`, agg, lang),
    mdTable(
      ["步骤", "耗时", "具体调用", "输出 tokens"],
      filtered.map((r) => [
        `#S${r.step}.${r.sub_index}`,
        formatDuration(r.duration_ms),
        escCell(truncate(r.command, 120)),
        `~${formatTokenCount(r.output_tokens)}`,
      ])
    ),
    "",
  ].join("\n");
}

export interface AnalysisReportInput {
  traj: TrajectoryIR;
  checker: CheckerResult;
  attr: Attribution;
  agentNotes?: string;
}

export function buildAnalysisReport(input: AnalysisReportInput): string {
  const { traj, checker, attr } = input;
  const rows = extractCommandCalls(traj);
  const tel = checker.telemetry_summary as Record<string, number>;
  const allAgg = aggregateCommands(rows);

  const topByTime = [...allAgg].sort((a, b) => b.total_duration_ms - a.total_duration_ms).slice(0, 15);
  const topByTokens = [...allAgg].sort((a, b) => b.total_output_tokens - a.total_output_tokens).slice(0, 15);
  const sessionWallMs = resolveSessionWallMs(traj);
  const userIdleMs = resolveUserIdleMs(traj);
  const sessionActiveWallMs = resolveSessionActiveWallMs(traj);
  const userTurns = traj.metadata.user_turns ?? 0;
  const stepCount = traj.metadata.step_count ?? traj.steps.length;
  const stepRatio = userTurns > 0 ? `${(stepCount / userTurns).toFixed(1)}:1` : "—";

  const metricRows: Array<[string, string]> = [
    ["用户轮次", String(userTurns)],
    ["Assistant 步骤", String(stepCount)],
    ["步数比 (assistant:user)", stepRatio],
  ];
  if (sessionWallMs != null) {
    metricRows.push(["会话墙时（含用户等待）", formatDuration(sessionWallMs)]);
  }
  if (sessionActiveWallMs != null) {
    metricRows.push(["会话活跃墙时（扣除用户等待）", formatDuration(sessionActiveWallMs)]);
  }
  if (userIdleMs != null && userIdleMs > 0) {
    metricRows.push(["用户等待时间", formatDuration(userIdleMs)]);
  }
  metricRows.push(
    ["工具调用次数", String(tel.total_tool_calls ?? rows.length)],
    ["工具总墙时", formatDuration(Number(tel.total_tool_duration_ms ?? 0))],
    ["工具输出 tokens", `~${formatTokenCount(Number(tel.total_output_tokens ?? 0))}`],
    ["静态主因", `**${attr.primary_cause}** (${attr.confidence})`],
    ["Violations", String(checker.violation_count)],
  );

  const lines: string[] = [
    `# Session 分析报告 — \`${traj.trajectory_id}\``,
    "",
    "> 单 session 独立报告：工具耗时与输出 token **按具体命令/路径/pattern 拆分**，非 Shell/Read 大类汇总。",
    "",
    "## 1. 任务摘要",
    "",
    truncate(traj.instruction || "（无首条用户消息）", 1500),
    "",
    "## 2. 会话指标",
    "",
    mdTable(["指标", "值"], metricRows),
    "",
    "> **会话墙时（含用户等待）**：首条 → 末条 transcript 事件跨度。**会话活跃墙时**：扣除各轮用户输入之间的等待空档（上一轮 agent 最后活动 → 下一条用户消息）。",
    "",
    "## 3. 归因与 Top Violations",
    "",
    attr.explanation,
    "",
  ];

  if (attr.top_violations?.length) {
    lines.push("**Top violations:**", "");
    for (const v of attr.top_violations.slice(0, 6)) {
      lines.push(`- \`[${v.severity}]\` **${v.invariant_id}** @ #S${v.step_index}: ${v.message}`);
    }
    lines.push("");
  }

  lines.push("## 4. Shell 命令耗时（具体命令）", "", sectionShell(rows));

  const readSec = sectionByTool("Read", "Read — 按文件路径", rows, "text");
  if (readSec) lines.push("## 5. Read 耗时与输出（按 path）", "", readSec);

  const grepSec = sectionByTool("Grep", "Grep — 按 pattern + path", rows, "text");
  if (grepSec) lines.push("## 6. Grep 耗时与输出（按 pattern）", "", grepSec);

  const mcpSec = sectionByTool("CallMcpTool", "MCP — 按 server/tool + 查询", rows, "json");
  if (mcpSec) lines.push("## 7. MCP 调用（按 server/tool）", "", mcpSec);

  const rest = [...new Set(rows.map((r) => r.tool))].filter((t) => !["Shell", "Read", "Grep", "CallMcpTool"].includes(t));
  if (rest.length) {
    lines.push("## 8. 其他工具", "");
    for (const t of rest) {
      lines.push(sectionByTool(t, t, rows, "text"));
    }
  }

  lines.push(
    "## 9. 全工具 — 耗时 Top 15（具体命令，非大类）",
    "",
    mdTable(
      ["工具", "具体命令", "次数", "总耗时", "总 tokens"],
      topByTime.map((a) => [
        a.tool,
        escCell(truncate(a.command, 120)),
        String(a.count),
        formatDuration(a.total_duration_ms),
        `~${formatTokenCount(a.total_output_tokens)}`,
      ])
    ),
    "",
    "## 10. 全工具 — 输出 tokens Top 15（具体命令）",
    "",
    mdTable(
      ["工具", "具体命令", "次数", "总 tokens", "总耗时"],
      topByTokens.map((a) => [
        a.tool,
        escCell(truncate(a.command, 120)),
        String(a.count),
        `~${formatTokenCount(a.total_output_tokens)}`,
        formatDuration(a.total_duration_ms),
      ])
    ),
    "",
  );

  lines.push(
    "---",
    "",
    "_Generated by TrajRx — 每份 session 独立 `analysis-report.md`；命令耗时拆到具体 Shell/Grep/Read/MCP 实例。_",
    ""
  );

  return lines.join("\n");
}

export function buildCommandBreakdownJson(traj: TrajectoryIR) {
  const rows = extractCommandCalls(traj);
  return {
    trajectory_id: traj.trajectory_id,
    call_count: rows.length,
    calls: rows,
    aggregates: aggregateCommands(rows),
  };
}
