import type { Attribution, CheckerResult, TrajectoryIR, ToolExecutionMetrics } from "../types/index.js";
import { classifyToolOptimization, countToolInputStats } from "../enrich/toolInputMetrics.js";
import { formatDuration, formatTokenCount } from "../enrich/toolMetrics.js";
import { resolveSessionActiveWallMs, resolveSessionWallMs, resolveSessionWallSource, resolveUserIdleMs, resolveUserIdleSource } from "../ir/sessionMetrics.js";

export interface CommandCallRow {
  step: number;
  sub_index: number;
  tool: string;
  command: string;
  duration_ms: number | null;
  duration_source: string;
  output_tokens: number;
  output_chars: number;
  input_chars: number;
  param_count: number;
  flag_count: number;
  fingerprint: string;
}

export interface CommandAggregateRow {
  fingerprint: string;
  tool: string;
  command: string;
  count: number;
  total_duration_ms: number;
  total_output_tokens: number;
  total_input_chars: number;
  total_param_count: number;
  max_param_count: number;
  avg_param_count: number;
  avg_duration_ms: number;
  steps: number[];
}

export interface ToolOptimizationRow {
  step: number;
  sub_index: number;
  tool: string;
  command: string;
  param_count: number;
  input_chars: number;
  output_tokens: number;
  level: "high" | "medium";
  reason: "input_params" | "output_tokens" | "both";
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
      const inputStats = countToolInputStats(sub.tool_name, inp);
      rows.push({
        step: step.index,
        sub_index: sub.sub_index,
        tool: sub.tool_name,
        command,
        duration_ms: ex?.duration_ms ?? null,
        duration_source: ex?.duration_source ?? "unknown",
        output_tokens: ex?.output_tokens ?? 0,
        output_chars: ex?.output_chars ?? 0,
        input_chars: inputStats.input_chars,
        param_count: inputStats.param_count,
        flag_count: inputStats.flag_count,
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
        total_input_chars: 0,
        total_param_count: 0,
        max_param_count: 0,
        avg_param_count: 0,
        avg_duration_ms: 0,
        steps: [],
      };
      map.set(r.fingerprint, agg);
    }
    agg.count++;
    agg.total_duration_ms += r.duration_ms ?? 0;
    agg.total_output_tokens += r.output_tokens;
    agg.total_input_chars += r.input_chars;
    agg.total_param_count += r.param_count;
    agg.max_param_count = Math.max(agg.max_param_count, r.param_count);
    agg.steps.push(r.step);
  }
  const out = [...map.values()];
  for (const a of out) {
    a.avg_duration_ms = a.count ? Math.round(a.total_duration_ms / a.count) : 0;
    a.avg_param_count = a.count ? Math.round((a.total_param_count / a.count) * 10) / 10 : 0;
  }
  return out.sort((a, b) => b.total_duration_ms - a.total_duration_ms || b.total_output_tokens - a.total_output_tokens);
}

export function extractOptimizationCandidates(rows: CommandCallRow[]): ToolOptimizationRow[] {
  const out: ToolOptimizationRow[] = [];
  for (const r of rows) {
    const tier = classifyToolOptimization(r.tool, r.param_count, r.input_chars, r.output_tokens);
    if (!tier) continue;
    out.push({
      step: r.step,
      sub_index: r.sub_index,
      tool: r.tool,
      command: r.command,
      param_count: r.param_count,
      input_chars: r.input_chars,
      output_tokens: r.output_tokens,
      level: tier.level,
      reason: tier.reason,
    });
  }
  return out.sort((a, b) => {
    const score = (row: ToolOptimizationRow) =>
      (row.level === "high" ? 1000 : 0)
      + row.param_count * 10
      + Math.min(row.output_tokens / 1000, 500)
      + row.input_chars / 100;
    return score(b) - score(a);
  });
}

function optimizationReasonLabel(reason: ToolOptimizationRow["reason"]): string {
  if (reason === "both") return "传参+输出";
  if (reason === "input_params") return "传参过多";
  return "输出过大";
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

export function redactCommandPreview(command: string): string {
  return command
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^:\s'"]+):([^@\s'"]+)@/gi, "$1:<redacted>@")
    .replace(/(\bAuthorization\s*:\s*(?:Bearer\s+)?)[^'"\s]+/gi, "$1<redacted>")
    .replace(
      /(\b(?:--?password|--?passwd|--?token|--?secret|appSecret|password)\b\s*(?:=|\s)\s*)(?:"[^"]*"|'[^']*'|[^\s;]+)/gi,
      "$1<redacted>",
    )
    .replace(/\s-p(?!\s)([^\s]+)/g, " -p<redacted>");
}

function commandPreview(command: string, max: number): string {
  return truncate(redactCommandPreview(command), max);
}

function sectionShell(rows: CommandCallRow[]): string {
  const shells = rows.filter((r) => r.tool === "Shell");
  if (!shells.length) return "_（无 Shell 调用）_\n";
  const agg = aggregateCommands(shells);
  const parts: string[] = [
    "### 按具体命令聚合（Shell）",
    "",
    mdTable(
      ["#", "次数", "总耗时", "均耗时", "传参", "输出 tokens", "步骤", "命令摘要"],
      agg.slice(0, 15).map((a, i) => [
        String(i + 1),
        String(a.count),
        formatDuration(a.total_duration_ms),
        formatDuration(a.avg_duration_ms),
        String(a.max_param_count),
        `~${formatTokenCount(a.total_output_tokens)}`,
        `#S${a.steps.slice(0, 5).join(", #S")}${a.steps.length > 5 ? "…" : ""}`,
        escCell(commandPreview(a.command, 72)),
      ])
    ),
    "",
    "> 默认报告只展示 Top 15 聚合；逐次调用和完整命令见 `command_breakdown.json`。",
    "",
  ];
  return parts.join("\n");
}

function sectionByTool(tool: string, title: string, rows: CommandCallRow[]): string {
  const filtered = rows.filter((r) => r.tool === tool);
  if (!filtered.length) return "";
  const agg = aggregateCommands(filtered);
  return [
    `### ${title}`,
    "",
    mdTable(
      ["#", "具体调用", "次数", "总耗时", "总输出 tokens", "步骤"],
      agg.slice(0, 10).map((a, i) => [
        String(i + 1),
        escCell(commandPreview(a.command, 100)),
        String(a.count),
        formatDuration(a.total_duration_ms),
        `~${formatTokenCount(a.total_output_tokens)}`,
        `#S${a.steps.slice(0, 4).join(", #S")}${a.steps.length > 4 ? "…" : ""}`,
      ])
    ),
    "",
    "> 默认报告只展示 Top 10 聚合；逐次调用和完整输入见 `command_breakdown.json`。",
    "",
  ].join("\n");
}

function sectionOtherTools(tools: string[], rows: CommandCallRow[]): string {
  const summaries = tools.map((tool) => {
    const calls = rows.filter((row) => row.tool === tool);
    const duration = calls.reduce((total, row) => total + (row.duration_ms ?? 0), 0);
    const outputTokens = calls.reduce((total, row) => total + row.output_tokens, 0);
    const maxParams = calls.reduce((max, row) => Math.max(max, row.param_count), 0);
    return { tool, count: calls.length, duration, outputTokens, maxParams };
  }).sort((left, right) =>
    right.duration - left.duration || right.outputTokens - left.outputTokens || right.count - left.count
  );
  return mdTable(
    ["工具", "次数", "总耗时", "输出 tokens", "最大传参"],
    summaries.map((summary) => [
      summary.tool,
      String(summary.count),
      formatDuration(summary.duration),
      `~${formatTokenCount(summary.outputTokens)}`,
      String(summary.maxParams),
    ]),
  );
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
  const optimizationRows = extractOptimizationCandidates(rows);

  const topByTime = [...allAgg].sort((a, b) => b.total_duration_ms - a.total_duration_ms).slice(0, 15);
  const topByTokens = [...allAgg].sort((a, b) => b.total_output_tokens - a.total_output_tokens).slice(0, 15);
  const topByParams = [...allAgg].sort((a, b) => b.max_param_count - a.max_param_count || b.total_input_chars - a.total_input_chars).slice(0, 15);
  const maxParamCount = rows.reduce((n, r) => Math.max(n, r.param_count), 0);
  const avgParamCount = rows.length ? Math.round((rows.reduce((n, r) => n + r.param_count, 0) / rows.length) * 10) / 10 : 0;
  const highParamCalls = rows.filter((r) => r.param_count >= 8).length;
  const highOutputCalls = rows.filter((r) => r.output_tokens >= 10_000).length;
  const sessionWallMs = resolveSessionWallMs(traj);
  const userIdleMs = resolveUserIdleMs(traj);
  const sessionActiveWallMs = resolveSessionActiveWallMs(traj);
  const userTurns = traj.metadata.user_turns ?? 0;
  const stepCount = traj.metadata.step_count ?? traj.steps.length;
  const stepRatio = userTurns > 0 ? `${(stepCount / userTurns).toFixed(1)}:1` : "—";
  const subagent = traj.metadata.subagent_efficiency;

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
  if (subagent && subagent.subagent_count > 0) {
    metricRows.push(
      ["子 Agent 会话 / 激活", `${subagent.subagent_count} / ${subagent.activation_count}`],
      ["子 Agent 执行累计", formatDuration(subagent.execution_sum_ms)],
      ["子 Agent 并行墙时（区间并集）", formatDuration(subagent.wall_union_ms)],
      ["主 Agent 显式等待子 Agent", subagent.parent_wait_ms === null
        ? "不可用"
        : `${formatDuration(subagent.parent_wait_ms)} / ${subagent.parent_wait_count ?? 0} 次`],
      ["子 Agent 最大并行度", String(subagent.max_parallelism)],
    );
    if (subagent.aborted_count > 0) {
      metricRows.push(["子 Agent 中止激活", String(subagent.aborted_count)]);
    }
  }
  metricRows.push(
    ["工具调用次数", String(tel.total_tool_calls ?? rows.length)],
    ["工具总墙时", formatDuration(Number(tel.total_tool_duration_ms ?? 0))],
    ["工具输出 tokens", `~${formatTokenCount(Number(tel.total_output_tokens ?? 0))}`],
    ["工具传参（最大/均）", `${maxParamCount} / ${avgParamCount}`],
    ["高传参调用 (≥8)", String(highParamCalls)],
    ["高输出调用 (≥10k tokens)", String(highOutputCalls)],
    ["静态主因", `**${attr.primary_cause}** (${attr.confidence})`],
    ["Violations", String(checker.violation_count)],
  );

  const sessionWallSource = resolveSessionWallSource(traj);
  const userIdleSource = resolveUserIdleSource(traj);
  const wallNote =
    sessionWallSource === "file_mtime"
      ? "**会话墙时（含用户等待）**：transcript 文件 birthtime → mtime（Cursor 无 per-event 时间戳时的近似值）。**会话活跃墙时**：gross 减去用户等待；idle 来自 terminal 时间戳间隙（`terminal_gaps`）或暂不可用。"
      : "**会话墙时（含用户等待）**：首条 → 末条 transcript 事件跨度。**会话活跃墙时**：扣除各轮用户输入之间的等待空档（上一轮 agent 最后活动 → 下一条用户消息）。";
  const idleNote =
    userIdleSource === "unavailable" && sessionWallSource === "file_mtime"
      ? " Cursor 用户等待暂无法从 transcript 精确拆分；net 与 gross 相同。"
      : "";

  const lines: string[] = [
    `# Session 分析报告 — \`${traj.trajectory_id}\``,
    "",
    "> 单 session 紧凑报告：默认展示 bounded Top 表；完整逐次调用保存在 `command_breakdown.json`。",
    "",
    "## 1. 任务摘要",
    "",
    truncate(traj.instruction || "（无首条用户消息）", 1500),
    "",
    "## 2. 会话指标",
    "",
    mdTable(["指标", "值"], metricRows),
    "",
    `> ${wallNote}${idleNote}`,
    "",
  ];

  if (subagent && subagent.subagent_count > 0) {
    const precision = subagent.timing_precision === "event_timestamps"
      ? "Codex task 事件时间戳"
      : "Cursor transcript 文件时间（近似）";
    lines.push(
      "### 2.1 子 Agent 执行明细",
      "",
      mdTable(
        ["任务", "层级", "激活", "执行累计", "状态", "计时来源"],
        subagent.subagents.slice(0, 20).map((child) => [
          escCell(child.task_name ?? child.nickname ?? child.session_id),
          String(child.depth),
          String(child.activation_count),
          formatDuration(child.execution_ms),
          child.status,
          child.timing_source,
        ]),
      ),
      "",
      `> 计时精度：${precision}。执行累计会重复计算并行 Agent；并行墙时不会。两者与主 Agent 等待时间不可相加。完整激活区间见 \`subagent_efficiency.json\`。`,
      "",
    );
  }

  lines.push(
    "## 3. 归因与 Top Violations",
    "",
    attr.explanation,
    "",
  );

  if (attr.top_violations?.length) {
    lines.push("**Top violations:**", "");
    for (const v of attr.top_violations.slice(0, 6)) {
      lines.push(`- \`[${v.severity}]\` **${v.invariant_id}** @ #S${v.step_index}: ${v.message}`);
    }
    lines.push("");
  }

  lines.push("## 4. 工具传参与输出优化", "", "_识别自定义工具（如 harness）传参过多、或单次输出 token 过大的调用，便于针对性改进 CLI/封装。_", "");

  if (optimizationRows.length) {
    lines.push(
      mdTable(
        ["优先级", "步骤", "工具", "传参", "输出 tokens", "输入 chars", "原因", "调用摘要"],
        optimizationRows.slice(0, 20).map((r) => [
          r.level === "high" ? "高" : "中",
          `#S${r.step}.${r.sub_index}`,
          r.tool,
          String(r.param_count),
          `~${formatTokenCount(r.output_tokens)}`,
          formatTokenCount(r.input_chars),
          optimizationReasonLabel(r.reason),
          escCell(commandPreview(r.command, 90)),
        ])
      ),
      "",
    );
  } else {
    lines.push("_（无达到优化阈值的工具调用）_", "");
  }

  lines.push(
    "### 传参 Top 15（按具体命令聚合）",
    "",
    mdTable(
      ["工具", "具体命令", "次数", "最大传参", "均传参", "输入 chars", "输出 tokens"],
      topByParams.map((a) => [
        a.tool,
        escCell(commandPreview(a.command, 100)),
        String(a.count),
        String(a.max_param_count),
        String(a.avg_param_count),
        formatTokenCount(a.total_input_chars),
        `~${formatTokenCount(a.total_output_tokens)}`,
      ])
    ),
    "",
    "> 传参计数：Shell 统计 `--flag`、`-Dprop=`、环境变量赋值；结构化工具统计非空 JSON 字段数。阈值：传参 ≥8 或输入 ≥600 chars 为中等；输出 ≥10k tokens 为中等，≥50k 为高。",
    "",
    "## 5. Shell 命令耗时（具体命令）",
    "",
    sectionShell(rows),
  );

  const readSec = sectionByTool("Read", "Read — 按文件路径", rows);
  if (readSec) lines.push("## 6. Read 耗时与输出（按 path）", "", readSec);

  const grepSec = sectionByTool("Grep", "Grep — 按 pattern + path", rows);
  if (grepSec) lines.push("## 7. Grep 耗时与输出（按 pattern）", "", grepSec);

  const mcpSec = sectionByTool("CallMcpTool", "MCP — 按 server/tool + 查询", rows);
  if (mcpSec) lines.push("## 8. MCP 调用（按 server/tool）", "", mcpSec);

  const rest = [...new Set(rows.map((r) => r.tool))].filter((t) => !["Shell", "Read", "Grep", "CallMcpTool"].includes(t));
  if (rest.length) {
    lines.push(
      "## 9. 其他工具（按工具聚合）",
      "",
      sectionOtherTools(rest, rows),
      "",
      "> 具体调用见 `command_breakdown.json`。",
      "",
    );
  }

  lines.push(
    "## 10. 全工具 — 耗时 Top 15（具体命令，非大类）",
    "",
    mdTable(
      ["工具", "具体命令", "次数", "总耗时", "总 tokens"],
      topByTime.map((a) => [
        a.tool,
        escCell(commandPreview(a.command, 120)),
        String(a.count),
        formatDuration(a.total_duration_ms),
        `~${formatTokenCount(a.total_output_tokens)}`,
      ])
    ),
    "",
    "## 11. 全工具 — 输出 tokens Top 15（具体命令）",
    "",
    mdTable(
      ["工具", "具体命令", "次数", "总 tokens", "总耗时"],
      topByTokens.map((a) => [
        a.tool,
        escCell(commandPreview(a.command, 120)),
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
    "_Generated by TrajRx — `analysis-report.md` 保持紧凑；完整调用明细见 `command_breakdown.json`。_",
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
    optimization_candidates: extractOptimizationCandidates(rows),
  };
}
