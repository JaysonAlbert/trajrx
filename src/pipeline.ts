import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { manualAttribution, reconcile } from "./analyst/reconcile.js";
import { appendAttributionSection, buildReport, flattenEventsToMarkdown, formatReconcileReport } from "./export/flatten.js";
import { buildAnalysisReport, buildCommandBreakdownJson } from "./export/analysisReport.js";
import { checkAll, writeCheckerResults } from "./invariants/checker.js";
import { attributeAll } from "./judge/attributor.js";
import { cursorIr } from "./ir/cursorIr.js";
import { codexIr } from "./ir/codexIr.js";
import { detectTranscriptFormat } from "./ir/detectFormat.js";
import { parseCodexRollout } from "./ir/codexParser.js";
import { loadTrajectories } from "./ir/loader.js";
import type { Attribution, CheckerResult, RawTrajectory, TrajectoryIR } from "./types/index.js";
import type { CodexRolloutEvent } from "./types/codex.js";
import { getRunsDir } from "./config.js";
import { aggregateSessionToolStats, buildEnrichmentContext, enrichAllToolCalls } from "./enrich/toolMetrics.js";
import { enrichCodexSession } from "./enrich/codexToolMetrics.js";
import { flattenCodexToMarkdown } from "./export/codexFlatten.js";
import { runAgentEval } from "./eval/runAgentEval.js";
import type { AgentCliId } from "./agentCli/types.js";

export const RUNS_DIR = getRunsDir();

export interface ProcessOptions {
  skipJudge?: boolean;
  agentEval?: boolean;
  agentCli?: AgentCliId;
  agentModel?: string;
}

function banner(msg: string) {
  console.log(`\n${"=".repeat(60)}\n  ${msg}\n${"=".repeat(60)}`);
}

function ensureDir(path: string) {
  mkdirSync(path, { recursive: true });
}

function isCodexTrajectory(raw: RawTrajectory): boolean {
  return raw._format === "codex_rollout" || detectTranscriptFormat(raw.events) === "codex_rollout";
}

function runEnrichment(inputPath: string, raw: RawTrajectory[]) {
  banner("Stage 0a: Tool Efficiency Enrichment");
  const traj = raw[0]!;
  if (isCodexTrajectory(traj)) {
    const session = parseCodexRollout(traj.events as CodexRolloutEvent[], traj.trajectory_id);
    const { metricsMap, sessionToolStats } = enrichCodexSession(session);
    console.log(`  format: codex_rollout, events: ${traj.events.length}`);
    console.log(`  background sessions: ${sessionToolStats.background_sessions.length}, thinking gaps: ${sessionToolStats.thinking_gaps_ms.length}`);
    console.log(`  total tool time: ${Math.round(sessionToolStats.total_duration_ms / 1000)}s, output tokens: ~${sessionToolStats.total_output_tokens.toLocaleString()}`);
    return { metricsMap, sessionToolStats: sessionToolStats as unknown as ReturnType<typeof aggregateSessionToolStats>, ctx: null, codexSession: session };
  }
  const ctx = buildEnrichmentContext(inputPath);
  const metricsMap = enrichAllToolCalls(traj.events as Parameters<typeof enrichAllToolCalls>[0], ctx);
  const sessionToolStats = aggregateSessionToolStats(traj.events as Parameters<typeof aggregateSessionToolStats>[0], metricsMap);
  console.log(`  format: cursor, terminals: ${ctx.terminals.length}, agent-tools: ${ctx.agentToolsTimeline.length}`);
  console.log(`  total tool time: ${Math.round(sessionToolStats.total_duration_ms / 1000)}s, output tokens: ~${sessionToolStats.total_output_tokens.toLocaleString()}`);
  return { metricsMap, sessionToolStats, ctx, codexSession: null };
}

function runFlatten(
  inputPath: string,
  runDir: string,
  raw: RawTrajectory[],
  metricsMap: ReturnType<typeof enrichAllToolCalls>,
  sessionToolStats: ReturnType<typeof aggregateSessionToolStats>,
  codexSession: ReturnType<typeof parseCodexRollout> | null
) {
  banner("Stage 0b: Flatten Transcript → Markdown");
  const traj = raw[0]!;
  const md = codexSession
    ? flattenCodexToMarkdown(traj.events as CodexRolloutEvent[], {
        trajectoryId: traj.trajectory_id,
        sourcePath: inputPath,
        toolMetrics: metricsMap,
        sessionToolStats: sessionToolStats as unknown as import("./enrich/codexToolMetrics.js").CodexSessionToolStats,
      })
    : flattenEventsToMarkdown(traj.events as Parameters<typeof flattenEventsToMarkdown>[0], {
        trajectoryId: traj.trajectory_id,
        sourcePath: inputPath,
        toolMetrics: metricsMap,
        sessionToolStats: sessionToolStats as unknown as Record<string, unknown>,
      });
  const outPath = join(runDir, `${traj.trajectory_id}.flat.md`);
  writeFileSync(outPath, md, "utf-8");
  console.log(`  Wrote ${outPath} (${traj.events.length} events → flat markdown)`);
  return outPath;
}

function runIr(
  raw: RawTrajectory[],
  runDir: string,
  metricsMap: ReturnType<typeof enrichAllToolCalls>,
  sessionToolStats: ReturnType<typeof aggregateSessionToolStats>
): { irPath: string; trajectories: TrajectoryIR[] } {
  banner("Stage 1/5: IR Normalization");
  const traj = raw[0]!;
  const data = isCodexTrajectory(traj)
    ? codexIr(traj.events as CodexRolloutEvent[], traj.trajectory_id, metricsMap, sessionToolStats as unknown as Record<string, unknown>)
    : cursorIr(raw, metricsMap, sessionToolStats as unknown as Record<string, unknown>);
  const outPath = join(runDir, "trajectory_ir.json");
  writeFileSync(outPath, JSON.stringify(data, null, 2), "utf-8");
  const toolMetricsPath = join(runDir, "tool_efficiency.json");
  writeFileSync(toolMetricsPath, JSON.stringify(sessionToolStats, null, 2), "utf-8");
  const steps = data.reduce((n, t) => n + t.steps.length, 0);
  console.log(`  Wrote ${outPath} (${data.length} trajectory/ies, ${steps} steps)`);
  console.log(`  Wrote ${toolMetricsPath}`);
  return { irPath: outPath, trajectories: data };
}

function runCheck(trajectories: TrajectoryIR[], runDir: string): { checkerDir: string; results: CheckerResult[] } {
  banner("Stage 2/5: Invariant Checking");
  const results = checkAll(trajectories);
  const outDir = join(runDir, "checker_results");
  const path = writeCheckerResults(results, outDir);
  const total = results.reduce((n, r) => n + r.violation_count, 0);
  console.log(`  Wrote ${path} (${total} violations)`);
  return { checkerDir: outDir, results };
}

function runJudge(trajectories: TrajectoryIR[], results: CheckerResult[], runDir: string): { judgePath: string; attributions: Attribution[] } {
  banner("Stage 3/5: Attribution (Judge)");
  const attributions = attributeAll(results, trajectories);
  const outDir = join(runDir, "judge_output");
  ensureDir(outDir);
  const outPath = join(outDir, "attribution.json");
  writeFileSync(outPath, JSON.stringify(attributions, null, 2), "utf-8");
  for (const a of attributions) {
    console.log(`  ${a.trajectory_id}: primary_cause=${a.primary_cause} confidence=${a.confidence}`);
  }
  return { judgePath: outPath, attributions };
}

function runReport(
  trajectories: TrajectoryIR[],
  results: CheckerResult[],
  attributions: Attribution[],
  runDir: string,
  flatMdPath: string
) {
  banner("Stage 4/5: Report");
  const reportsDir = join(runDir, "reports");
  ensureDir(reportsDir);
  const crMap = new Map(results.map((r) => [r.trajectory_id, r]));
  const attMap = new Map(attributions.map((a) => [a.trajectory_id, a]));

  for (const traj of trajectories) {
    const cr = crMap.get(traj.trajectory_id)!;
    const attr = attMap.get(traj.trajectory_id)!;
    const report = buildReport(traj, cr, attr);
    writeFileSync(join(reportsDir, `${traj.trajectory_id}.md`), report, "utf-8");

    const analysisMd = buildAnalysisReport({ traj, checker: cr, attr });
    writeFileSync(join(runDir, "analysis-report.md"), analysisMd, "utf-8");
    writeFileSync(join(runDir, "command_breakdown.json"), JSON.stringify(buildCommandBreakdownJson(traj), null, 2), "utf-8");
  }
  writeFileSync(join(reportsDir, "metrics.json"), JSON.stringify(attributions, null, 2), "utf-8");

  const traj = trajectories[0]!;
  const attr = attMap.get(traj.trajectory_id)!;
  const flat = appendAttributionSection(
    readFlat(flatMdPath),
    attr,
    crMap.get(traj.trajectory_id)!.violations
  );
  writeFileSync(flatMdPath, flat, "utf-8");
  console.log(`  Wrote reports/, analysis-report.md, command_breakdown.json; appended attribution to ${flatMdPath}`);
}

function readFlat(path: string): string {
  return readFileSync(path, "utf-8");
}

function runReconcile(trajectories: TrajectoryIR[], attributions: Attribution[], runDir: string) {
  banner("Stage 5/5: Reconciliation (static vs manual)");
  const outDir = join(runDir, "reconcile");
  ensureDir(outDir);
  const staticMap = new Map(attributions.map((a) => [a.trajectory_id, a]));
  const manualAttrs = [];
  const reconciliations = [];

  for (const traj of trajectories) {
    const manual = manualAttribution(traj);
    manualAttrs.push(manual);
    const rec = reconcile(staticMap.get(traj.trajectory_id)! as unknown as Record<string, unknown>, manual as unknown as Record<string, unknown>);
    reconciliations.push(rec);
    console.log(`  ${traj.trajectory_id}: verdict=${rec.verdict} static=${rec.static_primary} manual=${rec.manual_primary}`);
    writeFileSync(join(outDir, `${traj.trajectory_id}_reconcile.md`), formatReconcileReport(rec), "utf-8");
  }

  writeFileSync(join(outDir, "manual_attribution.json"), JSON.stringify(manualAttrs, null, 2), "utf-8");
  writeFileSync(join(outDir, "reconciliation.json"), JSON.stringify(reconciliations, null, 2), "utf-8");
}

async function runAgentEvalStage(runDir: string, inputPath: string, opts: ProcessOptions) {
  banner("Stage 6/6: Agent Evaluation (LLM via agent CLI)");
  const record = await runAgentEval({
    runDir,
    profileId: opts.agentCli,
    model: opts.agentModel,
    sourceTranscriptPath: inputPath,
  });
  console.log(`  Wrote ${record.output_path} via ${record.agent_cli} (${record.duration_ms}ms)`);
}

export async function processFile(inputPath: string, runName?: string, opts: ProcessOptions = {}) {
  const skipJudge = opts.skipJudge ?? false;
  const stem = basename(inputPath, extname(inputPath));
  const name = runName ?? `${stem}_${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15)}`;
  const runDir = join(RUNS_DIR, name);
  ensureDir(runDir);

  const raw = loadTrajectories(inputPath);
  const { metricsMap, sessionToolStats, codexSession } = runEnrichment(inputPath, raw);
  const flatMdPath = runFlatten(inputPath, runDir, raw, metricsMap, sessionToolStats, codexSession);
  const { trajectories } = runIr(raw, runDir, metricsMap, sessionToolStats);
  const { results } = runCheck(trajectories, runDir);

  if (skipJudge) {
    console.log("\n  (--skip-judge: attribution skipped)");
    return runDir;
  }

  const { attributions } = runJudge(trajectories, results, runDir);
  runReport(trajectories, results, attributions, runDir, flatMdPath);
  runReconcile(trajectories, attributions, runDir);

  if (opts.agentEval) {
    await runAgentEvalStage(runDir, inputPath, opts);
  }

  console.log(`\nDone. Output: ${runDir}`);
  return runDir;
}

export async function agentEvalOnly(runDir: string, opts: ProcessOptions = {}) {
  await runAgentEvalStage(runDir, runDir, opts);
  console.log(`\nAgent evaluation done: ${runDir}`);
  return runDir;
}

export function regenerateAnalysisFromRunDir(runDir: string) {
  const irPath = join(runDir, "trajectory_ir.json");
  const violPath = join(runDir, "checker_results", "violations.json");
  const attrPath = join(runDir, "judge_output", "attribution.json");
  const traj = JSON.parse(readFileSync(irPath, "utf-8"))[0] as TrajectoryIR;
  const checker = JSON.parse(readFileSync(violPath, "utf-8"))[0] as CheckerResult;
  const attr = JSON.parse(readFileSync(attrPath, "utf-8"))[0] as Attribution;
  const analysisMd = buildAnalysisReport({ traj, checker, attr });
  writeFileSync(join(runDir, "analysis-report.md"), analysisMd, "utf-8");
  writeFileSync(join(runDir, "command_breakdown.json"), JSON.stringify(buildCommandBreakdownJson(traj), null, 2), "utf-8");
  console.log(`Wrote ${join(runDir, "analysis-report.md")}`);
  return join(runDir, "analysis-report.md");
}

export function flattenOnly(inputPath: string, outputPath?: string, runName?: string) {
  const raw = loadTrajectories(inputPath);
  const traj = raw[0]!;
  const md = isCodexTrajectory(traj)
    ? flattenCodexToMarkdown(traj.events as CodexRolloutEvent[], { trajectoryId: traj.trajectory_id, sourcePath: inputPath })
    : flattenEventsToMarkdown(traj.events as Parameters<typeof flattenEventsToMarkdown>[0], { trajectoryId: traj.trajectory_id, sourcePath: inputPath });
  let out = outputPath;
  if (!out) {
    if (runName) {
      const runDir = join(RUNS_DIR, runName);
      ensureDir(runDir);
      out = join(runDir, `${traj.trajectory_id}.flat.md`);
    } else {
      out = join(dirname(inputPath), `${traj.trajectory_id}.flat.md`);
    }
  }
  ensureDir(dirname(resolve(out)));
  writeFileSync(out, md, "utf-8");
  console.log(`Wrote ${out}`);
  return out;
}
