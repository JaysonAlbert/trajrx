import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatInvokeCommand, invokeAgentCli } from "../agentCli/runner.js";
import { getAgentCliProfile, resolveDefaultAgentCliId, resolveDefaultAgentModel } from "../agentCli/profiles.js";
import type { AgentCliId, AgentCliInvokeRequest, AgentCliInvokeResult } from "../agentCli/types.js";
import type { Attribution, CheckerResult, TrajectoryIR } from "../types/index.js";
import {
  buildUnableToJudgeEvaluation,
  buildInitialEvalPrompt,
  buildSupplementEvalPrompt,
  parseSupplementRequest,
} from "./prompt.js";
import {
  writeEvalSlice,
  writeEvalSliceSupplement,
  type EvalSliceInput,
} from "./slice.js";

export interface RunAgentEvalOptions {
  runDir: string;
  profileId?: AgentCliId;
  model?: string;
  sourceTranscriptPath?: string;
  timeoutMs?: number;
  invokeAgent?: (request: AgentCliInvokeRequest) => Promise<AgentCliInvokeResult>;
}

export interface AgentEvalRecord {
  trajectory_id: string;
  method: string;
  agent_cli: AgentCliId;
  agent_model: string;
  command: string;
  commands: string[];
  passes: number;
  duration_ms: number;
  exit_code: number | null;
  timed_out: boolean;
  evaluated_at: string;
  output_path: string;
  eval_slice_path: string;
  eval_slice_supplement_path?: string;
  supplement_step_ids: number[];
  stderr?: string;
}

function loadRunArtifacts(runDir: string): {
  traj: TrajectoryIR;
  checker: CheckerResult;
  attr: Attribution;
  flatMdPath: string;
} {
  const irPath = join(runDir, "trajectory_ir.json");
  const violPath = join(runDir, "checker_results", "violations.json");
  const attrPath = join(runDir, "judge_output", "attribution.json");
  if (!existsSync(irPath) || !existsSync(violPath) || !existsSync(attrPath)) {
    throw new Error(`Run dir missing pipeline artifacts (need trajectory_ir.json, violations.json, attribution.json): ${runDir}`);
  }

  const traj = JSON.parse(readFileSync(irPath, "utf-8"))[0] as TrajectoryIR;
  const checker = JSON.parse(readFileSync(violPath, "utf-8"))[0] as CheckerResult;
  const attr = JSON.parse(readFileSync(attrPath, "utf-8"))[0] as Attribution;

  const flatCandidates = [
    join(runDir, `${traj.trajectory_id}.flat.md`),
    ...readdirSync(runDir).filter((f) => f.endsWith(".flat.md")).map((f) => join(runDir, f)),
  ];
  const flatMdPath = flatCandidates.find((p) => existsSync(p));
  if (!flatMdPath) {
    throw new Error(`No .flat.md found in ${runDir}`);
  }

  return { traj, checker, attr, flatMdPath };
}

function stripMarkdownFence(text: string): string {
  const trimmed = text.trim();
  const m = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/);
  return m ? m[1]!.trim() : trimmed;
}

function assertSuccessfulInvocation(
  result: AgentCliInvokeResult,
  timeoutMs: number | undefined,
  pass: number
): void {
  if (result.timedOut) {
    throw new Error(`Agent CLI pass ${pass} timed out after ${timeoutMs ?? 600000}ms`);
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `Agent CLI pass ${pass} exited ${result.exitCode}: ${result.stderr || result.stdout || "(no output)"}`
    );
  }
  if (!result.stdout.trim()) {
    throw new Error(`Agent CLI pass ${pass} returned empty stdout`);
  }
}

export async function runAgentEval(opts: RunAgentEvalOptions): Promise<AgentEvalRecord> {
  const profileId = opts.profileId ?? resolveDefaultAgentCliId();
  const profile = getAgentCliProfile(profileId);
  const model = opts.model?.trim() || resolveDefaultAgentModel(profile);
  const { traj, checker, attr, flatMdPath } = loadRunArtifacts(opts.runDir);

  const slice = writeEvalSlice({
    runDir: opts.runDir,
    traj,
    checker,
    attr,
    flatMdPath,
    sourceTranscriptPath: opts.sourceTranscriptPath,
  } satisfies EvalSliceInput);
  const invoke = opts.invokeAgent ?? invokeAgentCli;
  const firstResult = await invoke({
    profileId,
    model,
    prompt: buildInitialEvalPrompt(slice.markdownPath),
    cwd: opts.runDir,
    timeoutMs: opts.timeoutMs,
  });
  writeFileSync(
    join(opts.runDir, "judge_output", "agent_eval_pass1.raw.txt"),
    firstResult.stdout + "\n",
    "utf-8"
  );
  assertSuccessfulInvocation(firstResult, opts.timeoutMs, 1);

  const results = [firstResult];
  const request = parseSupplementRequest(firstResult.stdout);
  let supplementPath: string | undefined;
  let supplementStepIds: number[] = [];
  let finalResult = firstResult;
  let forcedFinalMarkdown: string | null = null;
  if (request) {
    const supplement = writeEvalSliceSupplement(
      { runDir: opts.runDir, flatMdPath },
      request.step_ids.filter((stepId) => !slice.selectedStepIds.includes(stepId))
    );
    supplementPath = supplement.markdownPath;
    supplementStepIds = supplement.includedStepIds;
    const secondResult = await invoke({
      profileId,
      model,
      prompt: buildSupplementEvalPrompt(slice.markdownPath, supplement.markdownPath, request.reason),
      cwd: opts.runDir,
      timeoutMs: opts.timeoutMs,
    });
    writeFileSync(
      join(opts.runDir, "judge_output", "agent_eval_pass2.raw.txt"),
      secondResult.stdout + "\n",
      "utf-8"
    );
    assertSuccessfulInvocation(secondResult, opts.timeoutMs, 2);
    results.push(secondResult);
    finalResult = secondResult;
    const repeatedRequest = parseSupplementRequest(secondResult.stdout);
    if (repeatedRequest) {
      forcedFinalMarkdown = buildUnableToJudgeEvaluation(
        repeatedRequest.reason,
        slice.markdownPath,
        supplement.markdownPath
      );
    }
  }

  const mdBody = forcedFinalMarkdown ?? stripMarkdownFence(finalResult.stdout);
  const outMd = join(opts.runDir, "agent-evaluation.md");
  writeFileSync(outMd, mdBody + "\n", "utf-8");

  const record: AgentEvalRecord = {
    trajectory_id: traj.trajectory_id,
    method: "agent_cli_v2_bounded_slice",
    agent_cli: profileId,
    agent_model: model,
    command: formatInvokeCommand(firstResult),
    commands: results.map(formatInvokeCommand),
    passes: results.length,
    duration_ms: results.reduce((total, result) => total + result.durationMs, 0),
    exit_code: finalResult.exitCode,
    timed_out: results.some((result) => result.timedOut),
    evaluated_at: new Date().toISOString(),
    output_path: outMd,
    eval_slice_path: slice.markdownPath,
    eval_slice_supplement_path: supplementPath,
    supplement_step_ids: supplementStepIds,
    stderr: results.map((result) => result.stderr).filter(Boolean).join("\n") || undefined,
  };

  writeFileSync(join(opts.runDir, "judge_output", "agent_evaluation.json"), JSON.stringify(record, null, 2), "utf-8");
  writeFileSync(
    join(opts.runDir, "source.json"),
    JSON.stringify(
      {
        session_id: traj.trajectory_id,
        source_transcript: opts.sourceTranscriptPath ?? traj.metadata.source_path,
        analyzed_at: record.evaluated_at,
        trajrx_run: opts.runDir,
        agent_cli: profileId,
        agent_model: model,
        agent_eval_method: record.method,
        agent_eval_passes: record.passes,
        eval_slice: slice.markdownPath,
        eval_slice_supplement: supplementPath ?? null,
      },
      null,
      2
    ),
    "utf-8"
  );

  return record;
}
