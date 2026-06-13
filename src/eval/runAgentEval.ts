import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatInvokeCommand, invokeAgentCli } from "../agentCli/runner.js";
import { getAgentCliProfile, resolveDefaultAgentCliId, resolveDefaultAgentModel } from "../agentCli/profiles.js";
import type { AgentCliId } from "../agentCli/types.js";
import type { Attribution, CheckerResult, TrajectoryIR } from "../types/index.js";
import { buildAgentEvalPrompt, writeEvalContext, type EvalContextInput } from "./prompt.js";

export interface RunAgentEvalOptions {
  runDir: string;
  profileId?: AgentCliId;
  model?: string;
  sourceTranscriptPath?: string;
  timeoutMs?: number;
}

export interface AgentEvalRecord {
  trajectory_id: string;
  method: string;
  agent_cli: AgentCliId;
  agent_model: string;
  command: string;
  duration_ms: number;
  exit_code: number | null;
  timed_out: boolean;
  evaluated_at: string;
  output_path: string;
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

export async function runAgentEval(opts: RunAgentEvalOptions): Promise<AgentEvalRecord> {
  const profileId = opts.profileId ?? resolveDefaultAgentCliId();
  const profile = getAgentCliProfile(profileId);
  const model = opts.model?.trim() || resolveDefaultAgentModel(profile);
  const { traj, checker, attr, flatMdPath } = loadRunArtifacts(opts.runDir);

  const evalContextPath = writeEvalContext({
    runDir: opts.runDir,
    traj,
    checker,
    attr,
    flatMdPath,
    sourceTranscriptPath: opts.sourceTranscriptPath,
  } satisfies EvalContextInput);

  const prompt = buildAgentEvalPrompt(evalContextPath, flatMdPath);
  const result = await invokeAgentCli({
    profileId,
    model,
    prompt,
    cwd: opts.runDir,
    timeoutMs: opts.timeoutMs,
  });

  const mdBody = stripMarkdownFence(result.stdout);
  const outMd = join(opts.runDir, "agent-evaluation.md");
  writeFileSync(outMd, mdBody + "\n", "utf-8");

  const record: AgentEvalRecord = {
    trajectory_id: traj.trajectory_id,
    method: "agent_cli_v1",
    agent_cli: profileId,
    agent_model: model,
    command: formatInvokeCommand(result),
    duration_ms: result.durationMs,
    exit_code: result.exitCode,
    timed_out: result.timedOut,
    evaluated_at: new Date().toISOString(),
    output_path: outMd,
    stderr: result.stderr || undefined,
  };

  writeFileSync(join(opts.runDir, "judge_output", "agent_evaluation.json"), JSON.stringify(record, null, 2), "utf-8");
  writeFileSync(
    join(opts.runDir, "source.json"),
    JSON.stringify(
      {
        session_id: traj.trajectory_id,
        source_transcript: opts.sourceTranscriptPath ?? traj.metadata.source_path,
        analyzed_at: record.evaluated_at,
        doctor_run: opts.runDir,
        agent_cli: profileId,
        agent_model: model,
      },
      null,
      2
    ),
    "utf-8"
  );

  if (result.timedOut) {
    throw new Error(`Agent CLI timed out after ${opts.timeoutMs ?? 600000}ms`);
  }
  if (result.exitCode !== 0) {
    throw new Error(`Agent CLI exited ${result.exitCode}: ${result.stderr || result.stdout || "(no output)"}`);
  }
  if (!mdBody) {
    throw new Error("Agent CLI returned empty stdout");
  }

  return record;
}
