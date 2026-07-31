import { existsSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import boxen from "boxen";
import pc from "picocolors";
import type { AgentCliId } from "../agentCli/types.js";

export interface RunArtifact {
  label: string;
  path: string;
  description?: string;
}

export interface RunSummary {
  run_name: string;
  run_dir: string;
  session_id: string;
  session_title?: string;
  source_transcript: string;
  format: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  events: number;
  steps: number;
  violations: number;
  primary_cause?: string;
  confidence?: number;
  reconcile_verdict?: string;
  session_wall_sec?: number;
  session_active_wall_sec?: number;
  user_idle_sec?: number;
  tool_time_sec?: number;
  output_tokens?: number;
  agent_eval?: {
    enabled: boolean;
    cli?: AgentCliId;
    model?: string;
    duration_ms?: number;
    output_path?: string;
  };
  artifacts: RunArtifact[];
  log_path: string;
}

export interface ReportLink {
  label: string;
  path: string;
  primary?: boolean;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return rem ? `${min}m ${rem}s` : `${min}m`;
}

function formatTokens(n?: number): string {
  if (n == null) return "—";
  if (n >= 1_000_000) return `~${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `~${Math.round(n / 1_000)}K`;
  return `~${n.toLocaleString()}`;
}

function displayPath(path: string): string {
  const home = process.env.HOME;
  if (home && path.startsWith(home)) return `~${path.slice(home.length)}`;
  return path;
}

function padLabel(label: string, width = 18): string {
  return `${label.padEnd(width)}`;
}

export function resolveReportLinks(summary: RunSummary): ReportLink[] {
  const runDir = summary.run_dir;
  const links: ReportLink[] = [];

  const analysisPath = join(runDir, "analysis-report.md");
  if (existsSync(analysisPath)) {
    links.push({ label: "Static analysis", path: analysisPath, primary: true });
  }

  const agentPath = summary.agent_eval?.output_path ?? join(runDir, "agent-evaluation.md");
  if (existsSync(agentPath)) {
    links.push({ label: "Agent evaluation", path: agentPath, primary: true });
  }

  const sessionReport = summary.artifacts.find((a) => a.path.includes("/reports/") && a.path.endsWith(".md"));
  if (sessionReport) {
    links.push({ label: "Session report", path: sessionReport.path });
  }

  links.push({ label: "Run summary", path: join(runDir, "run-summary.md") });
  links.push({ label: "Execution log", path: summary.log_path });

  return links;
}

function buildSummaryBody(summary: RunSummary): string {
  const lines: string[] = [];

  lines.push(`${padLabel("Run")}${summary.run_name}`);
  lines.push(`${padLabel("Session")}${summary.session_id}`);
  if (summary.session_title) {
    lines.push(`${padLabel("Title")}${summary.session_title}`);
  }

  lines.push("");

  if (summary.primary_cause) {
    const conf = summary.confidence != null ? ` (${Math.round(summary.confidence * 100)}%)` : "";
    lines.push(`${padLabel("Primary")}${summary.primary_cause}${conf} · ${summary.violations} violations`);
  } else {
    lines.push(`${padLabel("Violations")}${summary.violations}`);
  }

  if (summary.reconcile_verdict) {
    lines.push(`${padLabel("Reconcile")}${summary.reconcile_verdict}`);
  }

  const metrics = [
    summary.session_wall_sec != null ? `${summary.session_wall_sec}s session (gross)` : null,
    summary.session_active_wall_sec != null ? `${summary.session_active_wall_sec}s session (net)` : null,
    summary.tool_time_sec != null ? `${summary.tool_time_sec}s tool time` : null,
    summary.output_tokens != null ? `${formatTokens(summary.output_tokens)} tokens` : null,
    `${summary.steps} steps`,
    `${summary.events} events`,
  ].filter(Boolean).join(" · ");
  lines.push(`${padLabel("Metrics")}${metrics}`);
  lines.push(`${padLabel("Duration")}${formatDuration(summary.duration_ms)}`);

  if (summary.agent_eval?.enabled && summary.agent_eval.output_path) {
    const agent = summary.agent_eval;
    lines.push(`${padLabel("Agent eval")}${agent.cli}/${agent.model} · ${formatDuration(agent.duration_ms ?? 0)}`);
  }

  const reportLinks = resolveReportLinks(summary);
  lines.push("");
  lines.push(pc.bold("Open these files"));
  for (const link of reportLinks) {
    const prefix = link.primary ? pc.green("★") : " ";
    lines.push(`${prefix} ${link.label}`);
    lines.push(`  ${pc.cyan(displayPath(link.path))}`);
  }

  lines.push("");
  lines.push(`${padLabel("Run directory")}${displayPath(summary.run_dir)}`);

  return lines.join("\n");
}

export function printRunSummary(summary: RunSummary, verbose = false): void {
  const body = buildSummaryBody(summary);
  const boxed = boxen(body, {
    title: "TrajRx Analysis Complete",
    padding: 1,
    borderColor: "cyan",
    borderStyle: "round",
    width: Math.min(Math.max(process.stdout.columns ?? 80, 72), 100),
  });

  console.log("");
  console.log(boxed);
  console.log("");

  const primary = resolveReportLinks(summary).filter((l) => l.primary);
  if (primary.length) {
    console.log(pc.dim("Quick open:"));
    for (const link of primary) {
      console.log(pc.dim(`  open ${link.path}`));
    }
    console.log("");
  }

  if (verbose) {
    console.log(pc.dim(`Full artifact list: ${join(summary.run_dir, "run-summary.md")}`));
  }
}

export function writeRunSummaryFiles(summary: RunSummary): void {
  writeFileSync(join(summary.run_dir, "run-summary.json"), JSON.stringify(summary, null, 2), "utf-8");

  const reportLinks = resolveReportLinks(summary);
  const md = [
    "# TrajRx Run Summary",
    "",
    `| Field | Value |`,
    `| --- | --- |`,
    `| Run | \`${summary.run_name}\` |`,
    `| Session | \`${summary.session_id}\` |`,
    summary.session_title ? `| Title | ${summary.session_title} |` : null,
    `| Format | ${summary.format} |`,
    `| Duration | ${formatDuration(summary.duration_ms)} |`,
    `| Events | ${summary.events} |`,
    `| Steps | ${summary.steps} |`,
    `| Violations | ${summary.violations} |`,
    summary.primary_cause ? `| Primary cause | ${summary.primary_cause}${summary.confidence != null ? ` (${Math.round(summary.confidence * 100)}%)` : ""} |` : null,
    summary.reconcile_verdict ? `| Reconcile | ${summary.reconcile_verdict} |` : null,
    summary.session_wall_sec != null ? `| Session wall (gross) | ${summary.session_wall_sec}s |` : null,
    summary.session_active_wall_sec != null ? `| Session active (net) | ${summary.session_active_wall_sec}s |` : null,
    summary.user_idle_sec != null && summary.user_idle_sec > 0 ? `| User idle | ${summary.user_idle_sec}s |` : null,
    summary.tool_time_sec != null ? `| Tool time | ${summary.tool_time_sec}s |` : null,
    summary.output_tokens != null ? `| Output tokens | ${formatTokens(summary.output_tokens)} |` : null,
    `| Source transcript | \`${summary.source_transcript}\` |`,
    `| Started | ${summary.started_at} |`,
    `| Finished | ${summary.finished_at} |`,
    "",
    "## Reports (start here)",
    "",
    ...reportLinks.map((l) => `- **${l.label}**: \`${l.path}\``),
    "",
    "## All artifacts",
    "",
    ...summary.artifacts.map((a) => `- **${a.label}**: \`${a.path}\`${a.description ? ` — ${a.description}` : ""}`),
    "",
  ].filter(Boolean).join("\n");

  writeFileSync(join(summary.run_dir, "run-summary.md"), md, "utf-8");
}
