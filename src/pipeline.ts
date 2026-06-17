import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { manualAttribution, reconcile } from "./analyst/reconcile.js";
import { appendAttributionSection, buildReport, formatReconcileReport } from "./export/flatten.js";
import { buildAnalysisReport, buildCommandBreakdownJson } from "./export/analysisReport.js";
import { checkAll, writeCheckerResults } from "./invariants/checker.js";
import { attributeAll } from "./judge/attributor.js";
import { resolveAdapter, type TranscriptEnrichment } from "./ir/adapters/index.js";
import { loadTrajectories } from "./ir/loader.js";
import type { Attribution, CheckerResult, RawTrajectory, TrajectoryIR } from "./types/index.js";
import { getRunsDir } from "./config.js";
import { runAgentEval } from "./eval/runAgentEval.js";
import type { AgentCliId } from "./agentCli/types.js";
import { resolveSessionActiveWallMs, resolveSessionWallMs, resolveUserIdleMs } from "./ir/sessionMetrics.js";
import { PipelineUi } from "./ui/pipelineUi.js";
import type { RunArtifact, RunSummary } from "./ui/summary.js";

export const RUNS_DIR = getRunsDir();

export interface ProcessOptions {
  skipJudge?: boolean;
  agentEval?: boolean;
  agentCli?: AgentCliId;
  agentModel?: string;
  verbose?: boolean;
  sessionTitle?: string;
}

function ensureDir(path: string) {
  mkdirSync(path, { recursive: true });
}

function runEnrichment(inputPath: string, raw: RawTrajectory[], ui: PipelineUi): TranscriptEnrichment {
  const adapter = resolveAdapter(raw[0]!);
  const enrichment = adapter.enrich(inputPath, raw);
  ui.log(`format: ${enrichment.format}, events: ${enrichment.events}`);
  if (enrichment.codexSession) {
    const stats = enrichment.sessionToolStats as { background_sessions?: unknown[]; thinking_gaps_ms?: unknown[] };
    ui.log(`background sessions: ${stats.background_sessions?.length ?? 0}, thinking gaps: ${stats.thinking_gaps_ms?.length ?? 0}`);
  } else if (enrichment.cursorContext) {
    ui.log(`terminals: ${enrichment.cursorContext.terminals.length}, agent-tools: ${enrichment.cursorContext.agentToolsTimeline.length}`);
  }
  ui.log(`total tool time: ${enrichment.toolTimeSec}s, output tokens: ${enrichment.outputTokens}`);
  return enrichment;
}

function runFlatten(
  inputPath: string,
  runDir: string,
  raw: RawTrajectory[],
  enrichment: TranscriptEnrichment,
  ui: PipelineUi,
): string {
  const traj = raw[0]!;
  const adapter = resolveAdapter(traj);
  const md = adapter.flatten(raw, enrichment, {
    trajectoryId: traj.trajectory_id,
    sourcePath: inputPath,
  });
  const outPath = join(runDir, `${traj.trajectory_id}.flat.md`);
  writeFileSync(outPath, md, "utf-8");
  ui.log(`Wrote ${outPath} (${traj.events.length} events → flat markdown)`);
  return outPath;
}

function runIr(
  raw: RawTrajectory[],
  runDir: string,
  enrichment: TranscriptEnrichment,
  ui: PipelineUi,
): { irPath: string; trajectories: TrajectoryIR[]; steps: number } {
  const adapter = resolveAdapter(raw[0]!);
  const data = adapter.buildIr(raw, enrichment);
  const outPath = join(runDir, "trajectory_ir.json");
  writeFileSync(outPath, JSON.stringify(data, null, 2), "utf-8");
  const toolMetricsPath = join(runDir, "tool_efficiency.json");
  writeFileSync(toolMetricsPath, JSON.stringify(enrichment.sessionToolStats, null, 2), "utf-8");
  const steps = data.reduce((n, t) => n + t.steps.length, 0);
  ui.log(`Wrote ${outPath} (${data.length} trajectory/ies, ${steps} steps)`);
  ui.log(`Wrote ${toolMetricsPath}`);
  return { irPath: outPath, trajectories: data, steps };
}

function runCheck(trajectories: TrajectoryIR[], runDir: string, ui: PipelineUi): { checkerDir: string; results: CheckerResult[]; violations: number } {
  const results = checkAll(trajectories);
  const outDir = join(runDir, "checker_results");
  const path = writeCheckerResults(results, outDir);
  const total = results.reduce((n, r) => n + r.violation_count, 0);
  ui.log(`Wrote ${path} (${total} violations)`);
  return { checkerDir: outDir, results, violations: total };
}

function runJudge(trajectories: TrajectoryIR[], results: CheckerResult[], runDir: string, ui: PipelineUi): { judgePath: string; attributions: Attribution[] } {
  const attributions = attributeAll(results, trajectories);
  const outDir = join(runDir, "judge_output");
  ensureDir(outDir);
  const outPath = join(outDir, "attribution.json");
  writeFileSync(outPath, JSON.stringify(attributions, null, 2), "utf-8");
  for (const a of attributions) {
    ui.log(`${a.trajectory_id}: primary_cause=${a.primary_cause} confidence=${a.confidence}`);
  }
  return { judgePath: outPath, attributions };
}

function runReport(
  trajectories: TrajectoryIR[],
  results: CheckerResult[],
  attributions: Attribution[],
  runDir: string,
  flatMdPath: string,
  ui: PipelineUi,
) {
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
    readFileSync(flatMdPath, "utf-8"),
    attr,
    crMap.get(traj.trajectory_id)!.violations
  );
  writeFileSync(flatMdPath, flat, "utf-8");
  ui.log(`Wrote reports/, analysis-report.md, command_breakdown.json; appended attribution to ${flatMdPath}`);
}

function runReconcile(trajectories: TrajectoryIR[], attributions: Attribution[], runDir: string, ui: PipelineUi): string | undefined {
  const outDir = join(runDir, "reconcile");
  ensureDir(outDir);
  const staticMap = new Map(attributions.map((a) => [a.trajectory_id, a]));
  const manualAttrs = [];
  const reconciliations = [];
  let verdict: string | undefined;

  for (const traj of trajectories) {
    const manual = manualAttribution(traj);
    manualAttrs.push(manual);
    const rec = reconcile(staticMap.get(traj.trajectory_id)! as unknown as Record<string, unknown>, manual as unknown as Record<string, unknown>);
    reconciliations.push(rec);
    verdict = `${rec.verdict} (static=${rec.static_primary}, manual=${rec.manual_primary})`;
    ui.log(`${traj.trajectory_id}: verdict=${rec.verdict} static=${rec.static_primary} manual=${rec.manual_primary}`);
    writeFileSync(join(outDir, `${traj.trajectory_id}_reconcile.md`), formatReconcileReport(rec), "utf-8");
  }

  writeFileSync(join(outDir, "manual_attribution.json"), JSON.stringify(manualAttrs, null, 2), "utf-8");
  writeFileSync(join(outDir, "reconciliation.json"), JSON.stringify(reconciliations, null, 2), "utf-8");
  return verdict;
}

async function runAgentEvalStage(runDir: string, inputPath: string, opts: ProcessOptions, ui: PipelineUi) {
  return runAgentEval({
    runDir,
    profileId: opts.agentCli,
    model: opts.agentModel,
    sourceTranscriptPath: inputPath,
  }).then((record) => {
    ui.log(`Wrote ${record.output_path} via ${record.agent_cli} (${record.duration_ms}ms)`);
    return record;
  });
}

function buildArtifacts(
  runDir: string,
  trajectoryId: string,
  flatMdPath: string,
  opts: { agentEvalPath?: string; includeJudge?: boolean } = {},
): RunArtifact[] {
  const artifacts: RunArtifact[] = [];
  if (opts.agentEvalPath) {
    artifacts.push({ label: "agent-evaluation.md", path: opts.agentEvalPath, description: "LLM agent evaluation" });
  }
  artifacts.push(
    { label: "trajectory_ir.json", path: join(runDir, "trajectory_ir.json"), description: "Normalized trajectory IR" },
    { label: basename(flatMdPath), path: flatMdPath, description: "Flattened transcript" },
    { label: "checker_results/violations.json", path: join(runDir, "checker_results", "violations.json"), description: "Invariant violations" },
  );
  if (opts.includeJudge) {
    artifacts.push(
      { label: "analysis-report.md", path: join(runDir, "analysis-report.md"), description: "Static analysis report" },
      { label: "judge_output/attribution.json", path: join(runDir, "judge_output", "attribution.json"), description: "Rule-based attribution" },
      { label: "reconcile/reconciliation.json", path: join(runDir, "reconcile", "reconciliation.json"), description: "Static vs manual reconcile" },
      { label: `reports/${trajectoryId}.md`, path: join(runDir, "reports", `${trajectoryId}.md`), description: "Per-session report" },
    );
  }
  return artifacts.filter((a) => existsSync(a.path));
}

export async function processFile(inputPath: string, runName?: string, opts: ProcessOptions = {}) {
  const skipJudge = opts.skipJudge ?? false;
  const startedAt = new Date();
  const stem = basename(inputPath, extname(inputPath));
  const name = runName ?? `${stem}_${startedAt.toISOString().replace(/[-:T]/g, "").slice(0, 15)}`;
  const runDir = join(RUNS_DIR, name);
  ensureDir(runDir);

  const ui = new PipelineUi({ runDir, verbose: opts.verbose });
  ui.header("Trajectory Analysis", basename(inputPath));
  ui.log(`Starting analysis for ${inputPath}`);
  ui.log(`Run directory: ${runDir}`);

  const raw = loadTrajectories(inputPath);
  const traj = raw[0]!;
  let enrichment!: TranscriptEnrichment;
  let flatMdPath = "";
  let trajectories: TrajectoryIR[] = [];
  let steps = 0;
  let violations = 0;
  let checkerResults: CheckerResult[] = [];
  let attributions: Attribution[] = [];
  let reconcileVerdict: string | undefined;
  let agentRecord: Awaited<ReturnType<typeof runAgentEval>> | undefined;

  const stages = [
    {
      title: "Tool efficiency enrichment",
      run: async ({ setDetail }: { setDetail: (d: string) => void }) => {
        setDetail("Parsing transcript…");
        enrichment = runEnrichment(inputPath, raw, ui);
        return enrichment.detail;
      },
    },
    {
      title: "Flatten transcript",
      run: async ({ setDetail }: { setDetail: (d: string) => void }) => {
        setDetail("Writing markdown…");
        flatMdPath = runFlatten(inputPath, runDir, raw, enrichment, ui);
        return basename(flatMdPath);
      },
    },
    {
      title: "IR normalization",
      run: async ({ setDetail }: { setDetail: (d: string) => void }) => {
        setDetail("Building trajectory IR…");
        const ir = runIr(raw, runDir, enrichment, ui);
        trajectories = ir.trajectories;
        steps = ir.steps;
        return `${steps} steps`;
      },
    },
    {
      title: "Invariant checking",
      run: async ({ setDetail }: { setDetail: (d: string) => void }) => {
        setDetail("Running static rules…");
        const check = runCheck(trajectories, runDir, ui);
        checkerResults = check.results;
        violations = check.violations;
        return `${violations} violations`;
      },
    },
  ];

  if (!skipJudge) {
    stages.push(
      {
        title: "Attribution",
        run: async ({ setDetail }: { setDetail: (d: string) => void }) => {
          setDetail("Scoring inefficiency…");
          const judge = runJudge(trajectories, checkerResults, runDir, ui);
          attributions = judge.attributions;
          const attr = attributions[0];
          return attr ? `${attr.primary_cause} (${Math.round(attr.confidence * 100)}%)` : "done";
        },
      },
      {
        title: "Report generation",
        run: async ({ setDetail }: { setDetail: (d: string) => void }) => {
          setDetail("Writing reports…");
          runReport(trajectories, checkerResults, attributions, runDir, flatMdPath, ui);
          return "analysis-report.md";
        },
      },
      {
        title: "Reconciliation",
        run: async ({ setDetail }: { setDetail: (d: string) => void }) => {
          setDetail("Comparing static vs manual…");
          reconcileVerdict = runReconcile(trajectories, attributions, runDir, ui);
          return reconcileVerdict ?? "done";
        },
      },
    );
  }

  if (opts.agentEval && !skipJudge) {
    stages.push({
      title: "Agent evaluation",
      run: async ({ setDetail }: { setDetail: (d: string) => void }) => {
        setDetail("Invoking agent CLI…");
        agentRecord = await runAgentEvalStage(runDir, inputPath, opts, ui);
        return `${agentRecord.agent_cli}/${agentRecord.agent_model} · ${Math.round(agentRecord.duration_ms / 1000)}s`;
      },
    });
  }

  await ui.runStages(stages);

  const finishedAt = new Date();
  const attr = attributions[0];
  const sessionId = trajectories[0]?.trajectory_id ?? traj.trajectory_id;
  const trajMeta = trajectories[0] ?? { metadata: {} as TrajectoryIR["metadata"] };
  const sessionWallMs = resolveSessionWallMs(trajMeta as TrajectoryIR);
  const sessionActiveWallMs = resolveSessionActiveWallMs(trajMeta as TrajectoryIR);
  const userIdleMs = resolveUserIdleMs(trajMeta as TrajectoryIR);
  const summary: RunSummary = {
    run_name: name,
    run_dir: runDir,
    session_id: sessionId,
    session_title: opts.sessionTitle,
    source_transcript: inputPath,
    format: enrichment.format,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: finishedAt.getTime() - startedAt.getTime(),
    events: enrichment.events,
    steps,
    violations,
    primary_cause: attr?.primary_cause,
    confidence: attr?.confidence,
    reconcile_verdict: reconcileVerdict,
    session_wall_sec: sessionWallMs != null ? Math.round(sessionWallMs / 1000) : undefined,
    session_active_wall_sec: sessionActiveWallMs != null ? Math.round(sessionActiveWallMs / 1000) : undefined,
    user_idle_sec: userIdleMs != null ? Math.round(userIdleMs / 1000) : undefined,
    tool_time_sec: enrichment.toolTimeSec,
    output_tokens: enrichment.outputTokens,
    agent_eval: {
      enabled: Boolean(opts.agentEval && !skipJudge),
      cli: agentRecord?.agent_cli,
      model: agentRecord?.agent_model,
      duration_ms: agentRecord?.duration_ms,
      output_path: agentRecord?.output_path,
    },
    artifacts: buildArtifacts(runDir, sessionId, flatMdPath, {
      agentEvalPath: agentRecord?.output_path,
      includeJudge: !skipJudge,
    }),
    log_path: ui.logger.path,
  };

  ui.finish(summary);
  return runDir;
}

export async function agentEvalOnly(runDir: string, opts: ProcessOptions = {}) {
  const startedAt = new Date();
  const ui = new PipelineUi({ runDir, verbose: opts.verbose });
  ui.header("Agent Evaluation", basename(runDir));

  let agentRecord: Awaited<ReturnType<typeof runAgentEval>>;
  await ui.runStages([
    {
      title: "Agent evaluation",
      run: async ({ setDetail }) => {
        setDetail("Invoking agent CLI…");
        agentRecord = await runAgentEvalStage(runDir, runDir, opts, ui);
        return `${agentRecord.agent_cli}/${agentRecord.agent_model} · ${Math.round(agentRecord.duration_ms / 1000)}s`;
      },
    },
  ]);

  const traj = JSON.parse(readFileSync(join(runDir, "trajectory_ir.json"), "utf-8"))[0] as TrajectoryIR;
  const flatCandidates = [join(runDir, `${traj.trajectory_id}.flat.md`), ...requireFlat(runDir)];
  const flatMdPath = flatCandidates.find((p) => existsSync(p)) ?? join(runDir, `${traj.trajectory_id}.flat.md`);
  const finishedAt = new Date();

  const summary: RunSummary = {
    run_name: basename(runDir),
    run_dir: runDir,
    session_id: traj.trajectory_id,
    source_transcript: String(traj.metadata.source_path ?? runDir),
    format: String(traj.source ?? "unknown"),
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    duration_ms: finishedAt.getTime() - startedAt.getTime(),
    events: Number(traj.metadata.event_count ?? 0),
    steps: traj.steps.length,
    violations: 0,
    agent_eval: {
      enabled: true,
      cli: agentRecord!.agent_cli,
      model: agentRecord!.agent_model,
      duration_ms: agentRecord!.duration_ms,
      output_path: agentRecord!.output_path,
    },
    artifacts: [
      { label: "agent-evaluation.md", path: agentRecord!.output_path, description: "LLM agent evaluation" },
      { label: "analysis-report.md", path: join(runDir, "analysis-report.md"), description: "Static analysis report" },
    ],
    log_path: ui.logger.path,
  };

  ui.finish(summary);
  return runDir;
}

function requireFlat(runDir: string): string[] {
  return readdirSync(runDir).filter((f) => f.endsWith(".flat.md")).map((f) => join(runDir, f));
}

export function regenerateAnalysisFromRunDir(runDir: string) {
  const irPath = join(runDir, "trajectory_ir.json");
  const violPath = join(runDir, "checker_results", "violations.json");
  const attrPath = join(runDir, "judge_output", "attribution.json");
  const traj = JSON.parse(readFileSync(irPath, "utf-8"))[0] as TrajectoryIR;
  const checker = JSON.parse(readFileSync(violPath, "utf-8"))[0] as CheckerResult;
  const attr = JSON.parse(readFileSync(attrPath, "utf-8"))[0] as Attribution;
  const analysisMd = buildAnalysisReport({ traj, checker, attr });
  const out = join(runDir, "analysis-report.md");
  writeFileSync(out, analysisMd, "utf-8");
  writeFileSync(join(runDir, "command_breakdown.json"), JSON.stringify(buildCommandBreakdownJson(traj), null, 2), "utf-8");
  console.log(`Wrote ${out}`);
  return out;
}

export function flattenOnly(inputPath: string, outputPath?: string, runName?: string) {
  const raw = loadTrajectories(inputPath);
  const traj = raw[0]!;
  const adapter = resolveAdapter(traj);
  const enrichment = adapter.enrich(inputPath, raw);
  const md = adapter.flatten(raw, enrichment, {
    trajectoryId: traj.trajectory_id,
    sourcePath: inputPath,
  });
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
