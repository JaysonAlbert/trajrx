import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Attribution, CheckerResult, TrajectoryIR } from "../types/index.js";

export interface EvalContextInput {
  runDir: string;
  traj: TrajectoryIR;
  checker: CheckerResult;
  attr: Attribution;
  flatMdPath: string;
  sourceTranscriptPath?: string;
}

function readOptional(path: string): string | null {
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf-8");
}

function readJsonOptional(path: string): unknown | null {
  const raw = readOptional(path);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function writeEvalContext(input: EvalContextInput): string {
  const { runDir, traj, checker, attr, flatMdPath, sourceTranscriptPath } = input;
  const analysisReport = readOptional(join(runDir, "analysis-report.md"));
  const toolEfficiency = readJsonOptional(join(runDir, "tool_efficiency.json"));
  const reconciliation = readJsonOptional(join(runDir, "reconciliation.json"));
  const manualAttr = readJsonOptional(join(runDir, "reconcile", "manual_attribution.json"));

  const lines = [
    "# Doctor Agent Evaluation Context",
    "",
    "You are the **LLM evaluation path** for doctor (AgentRx-style IDE agent efficiency attribution).",
    "A deterministic rule pipeline has already run. Your job is to read the artifacts, judge efficiency,",
    "compare with static attribution, and explain divergences.",
    "",
    "## Session",
    `- trajectory_id: ${traj.trajectory_id}`,
    `- instruction: ${traj.instruction || "(unknown)"}`,
    `- user_turns: ${traj.metadata.user_turns ?? "?"}`,
    `- assistant_steps: ${traj.steps.length}`,
    sourceTranscriptPath ? `- source_transcript: ${sourceTranscriptPath}` : "",
    "",
    "## Artifacts to read (use your Read tool)",
    `- flat transcript: ${flatMdPath}`,
    `- analysis report: ${join(runDir, "analysis-report.md")}`,
    `- tool efficiency: ${join(runDir, "tool_efficiency.json")}`,
    `- static attribution: ${join(runDir, "judge_output", "attribution.json")}`,
    `- violations: ${join(runDir, "checker_results", "violations.json")}`,
    `- reconciliation: ${join(runDir, "reconcile", "reconciliation.json")}`,
    "",
    "## Static pipeline summary (embedded)",
    "",
    "### Attribution (rules)",
    "```json",
    JSON.stringify(attr, null, 2),
    "```",
    "",
    "### Top violations",
    "```json",
    JSON.stringify((checker.violations ?? []).slice(0, 12), null, 2),
    "```",
    "",
    "### Tool efficiency (summary)",
    "```json",
    JSON.stringify(toolEfficiency, null, 2),
    "```",
    "",
    reconciliation
      ? `### Reconciliation\n\`\`\`json\n${JSON.stringify(reconciliation, null, 2)}\n\`\`\`\n`
      : "",
    manualAttr
      ? `### Manual heuristic attribution\n\`\`\`json\n${JSON.stringify(manualAttr, null, 2)}\n\`\`\`\n`
      : "",
    analysisReport
      ? `### Analysis report (embedded)\n\n${analysisReport}\n`
      : "",
    "## Output contract",
    "",
    "Respond with **only** a Markdown document (no preamble) using this structure:",
    "",
    "```markdown",
    "# Agent Evaluation — <short session id>",
    "",
    "## 任务",
    "(1-3 sentences: what the user asked, delivery outcome if inferable)",
    "",
    "## 工具效率",
    "(table: wall time, output tokens, slowest calls, call patterns)",
    "",
    "## 静态工具结论 (doctor)",
    "(table: primary_cause, confidence, violations count, reconcile verdict)",
    "",
    "## Agent 评估",
    "### 效率判断：**高/中/低**",
    "**主因（Agent）：** context | tool | mcp | skill | none | compound",
    "- bullet evidence tied to step ids (#SN / #UN) when possible",
    "- explicitly compare with static primary_cause; if divergent, explain why",
    "",
    "**建议：** (actionable improvements for rules/skills/MCP/tooling)",
    "",
    "## artifact 索引",
    "- list key artifact paths",
    "```",
    "",
    "Categories must be: context, tool, mcp, skill, none, or compound.",
    "Write in Chinese. Be concise but evidence-based.",
  ].filter((l) => l !== "");

  const outPath = join(runDir, "eval_context.md");
  writeFileSync(outPath, lines.join("\n"), "utf-8");
  return outPath;
}

export function buildAgentEvalPrompt(evalContextPath: string, flatMdPath: string): string {
  return [
    "Run a doctor agent-evaluation job.",
    "",
    `1. Read ${evalContextPath} completely.`,
    `2. Read the flat transcript at ${flatMdPath} (skim structure; deep-read hotspots cited in static violations).`,
    "3. Produce the agent-evaluation markdown per the Output contract in eval_context.",
    "4. Output ONLY the markdown document. No JSON wrapper, no commentary before/after.",
  ].join("\n");
}
