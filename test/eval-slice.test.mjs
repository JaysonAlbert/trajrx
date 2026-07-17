import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { runAgentEval } from "../dist/eval/runAgentEval.js";
import { writeEvalSlice } from "../dist/eval/slice.js";

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf-8");
}

function makeRunDir() {
  const runDir = mkdtempSync(join(tmpdir(), "trajrx-eval-slice-"));
  mkdirSync(join(runDir, "checker_results"), { recursive: true });
  mkdirSync(join(runDir, "judge_output"), { recursive: true });
  mkdirSync(join(runDir, "reconcile"), { recursive: true });

  const trajectoryId = "trajectory-test";
  const steps = [1, 2, 3, 4, 5].map((index) => ({
    index,
    telemetry: {},
    substeps: [],
  }));
  writeJson(join(runDir, "trajectory_ir.json"), [{
    trajectory_id: trajectoryId,
    source: "codex",
    instruction: "Fix the test flow",
    metadata: { user_turns: 2, step_count: 5 },
    steps,
  }]);
  writeJson(join(runDir, "checker_results", "violations.json"), [{
    trajectory_id: trajectoryId,
    violation_count: 1,
    telemetry_summary: { total_tool_calls: 12 },
    violations: [{
      invariant_id: "INV-TOOL-005",
      category: "tool",
      step_index: 3,
      severity: "high",
      message: "large output",
      evidence: { output_tokens: 9000 },
    }],
  }]);
  writeJson(join(runDir, "judge_output", "attribution.json"), [{
    trajectory_id: trajectoryId,
    primary_cause: "tool",
    confidence: 0.9,
    critical_step: 2,
    category_scores: { tool: 10 },
    violations_by_category: { tool: 1 },
    top_violations: [],
    explanation: "tool output dominates",
    recommended_actions: [],
  }]);
  writeJson(join(runDir, "tool_efficiency.json"), {
    total_duration_ms: 1200,
    total_output_tokens: 12345,
    by_tool: { exec_command: { count: 12, total_duration_ms: 1200, total_output_tokens: 12345 } },
    largest_outputs: [{ step: 4, tool: "exec_command", output_tokens: 8000, duration_ms: 10 }],
    slowest: [{ step: 5, tool: "exec_command", output_tokens: 10, duration_ms: 900 }],
  });
  writeJson(join(runDir, "reconcile", "reconciliation.json"), [{
    verdict: "consistent",
    static_primary: "tool",
    manual_primary: "context",
    primary_match: false,
  }]);

  const flatPath = join(runDir, `${trajectoryId}.flat.md`);
  writeFileSync(flatPath, [
    "# Codex Session Transcript",
    "",
    "## Task (first user message)",
    "",
    "Fix the test flow.",
    "",
    "## User Turn 1 (#U1)",
    "",
    "Please start.",
    "",
    "## Assistant Step 1 (#S1, after #U1)",
    "",
    "Unselected exploration.",
    "",
    "## Assistant Step 2 (#S2, after #U1)",
    "",
    "Critical step.",
    "",
    "## Assistant Step 3 (#S3, after #U1)",
    "",
    "High severity evidence.",
    "",
    "## User Turn 2 (#U2)",
    "",
    "Please finish.",
    "",
    "## Assistant Step 4 (#S4, after #U2)",
    "",
    "Largest output step.",
    "",
    "## Assistant Step 5 (#S5, after #U2)",
    "",
    "Final answer.",
    "",
    "## Session Stats",
    "",
    "- assistant_steps: 5",
    "",
    "## Attribution Summary (TrajRx)",
    "",
    "Generated summary.",
  ].join("\n"), "utf-8");

  return { runDir, flatPath };
}

function successfulResult(stdout) {
  return {
    profileId: "cursor",
    binary: "cursor-agent",
    argv: ["cursor-agent", "-p", "prompt"],
    stdout,
    stderr: "",
    exitCode: 0,
    durationMs: 100,
    timedOut: false,
  };
}

test("writeEvalSlice deterministically includes mandatory sections and rule-selected hotspots", () => {
  const { runDir, flatPath } = makeRunDir();
  const input = {
    runDir,
    traj: JSON.parse(readFileSync(join(runDir, "trajectory_ir.json"), "utf-8"))[0],
    checker: JSON.parse(readFileSync(join(runDir, "checker_results", "violations.json"), "utf-8"))[0],
    attr: JSON.parse(readFileSync(join(runDir, "judge_output", "attribution.json"), "utf-8"))[0],
    flatMdPath: flatPath,
  };

  const first = writeEvalSlice(input);
  const firstBody = readFileSync(first.markdownPath, "utf-8");
  const second = writeEvalSlice(input);
  const secondBody = readFileSync(second.markdownPath, "utf-8");

  assert.equal(firstBody, secondBody);
  assert.match(firstBody, /Fix the test flow/);
  assert.match(firstBody, /Please start/);
  assert.match(firstBody, /Please finish/);
  assert.match(firstBody, /Final answer/);
  assert.match(firstBody, /Critical step/);
  assert.match(firstBody, /High severity evidence/);
  assert.match(firstBody, /Largest output step/);
  assert.doesNotMatch(firstBody, /Unselected exploration/);
  assert.doesNotMatch(firstBody, /assistant_steps: 5/);
  assert.deepEqual(first.selectedStepIds, [2, 3, 4, 5]);
  assert.ok(first.sizeChars <= first.bounds.maxSliceChars);
});

test("writeEvalSlice keeps every user turn and the final step within the total bound", () => {
  const { runDir, flatPath } = makeRunDir();
  const sections = [
    "# Codex Session Transcript",
    "",
    "## Task (first user message)",
    "",
    "Bound a large transcript.",
    "",
  ];
  for (let index = 1; index <= 30; index += 1) {
    sections.push(
      `## User Turn ${index} (#U${index})`,
      "",
      `user-${index}-${"u".repeat(10_000)}`,
      "",
      `## Assistant Step ${index} (#S${index}, after #U${index})`,
      "",
      `assistant-${index}-${"a".repeat(10_000)}`,
      ""
    );
  }
  sections.push("## Session Stats", "", "- assistant_steps: 30", "");
  writeFileSync(flatPath, sections.join("\n"), "utf-8");
  const input = {
    runDir,
    traj: JSON.parse(readFileSync(join(runDir, "trajectory_ir.json"), "utf-8"))[0],
    checker: JSON.parse(readFileSync(join(runDir, "checker_results", "violations.json"), "utf-8"))[0],
    attr: JSON.parse(readFileSync(join(runDir, "judge_output", "attribution.json"), "utf-8"))[0],
    flatMdPath: flatPath,
  };

  const result = writeEvalSlice(input);
  const body = readFileSync(result.markdownPath, "utf-8");

  assert.ok(result.sizeChars <= result.bounds.maxSliceChars);
  for (let index = 1; index <= 30; index += 1) {
    assert.match(body, new RegExp(`## User Turn ${index} \\(#U${index}\\)`));
  }
  assert.match(body, /## Assistant Step 30 \(#S30, after #U30\)/);
  assert.equal(result.finalStepId, 30);
});

test("runAgentEval performs at most one bounded supplemental pass", async () => {
  const { runDir } = makeRunDir();
  const invocations = [];
  const outputs = [
    successfulResult(JSON.stringify({
      status: "needs_more_evidence",
      step_ids: [1, 99, 1],
      reason: "Need the initial exploration.",
    })),
    successfulResult([
      "# Agent Evaluation — test",
      "",
      "## 任务与结果",
      "- 交付结果：无法判断",
      "",
      "## 效率",
      "- 等级：中",
      "- 主因：tool",
      "",
      "## 与静态结论对照",
      "- evidence",
      "",
      "## 改进建议",
      "1. Narrow reads.",
      "",
      "## artifact 索引",
      "- eval_slice.md",
    ].join("\n")),
  ];
  const invokeAgent = async (request) => {
    invocations.push(request);
    return outputs.shift();
  };

  const record = await runAgentEval({ runDir, invokeAgent });

  assert.equal(invocations.length, 2);
  assert.equal(record.passes, 2);
  assert.deepEqual(record.supplement_step_ids, [1]);
  assert.ok(record.eval_slice_path.endsWith("eval_slice.md"));
  assert.ok(record.eval_slice_supplement_path.endsWith("eval_slice_supplement.md"));
  assert.match(readFileSync(record.eval_slice_supplement_path, "utf-8"), /Unselected exploration/);
  assert.match(invocations[1].prompt, /No third pass is allowed/);
  assert.match(readFileSync(record.output_path, "utf-8"), /交付结果：无法判断/);
  assert.ok(existsSync(join(runDir, "judge_output", "agent_eval_pass1.raw.txt")));
  assert.ok(existsSync(join(runDir, "judge_output", "agent_eval_pass2.raw.txt")));
});

test("runAgentEval stops after one pass when the slice is sufficient", async () => {
  const { runDir } = makeRunDir();
  let invocations = 0;
  const invokeAgent = async () => {
    invocations += 1;
    return successfulResult("# Agent Evaluation — enough\n\n## 任务与结果\n- 交付结果：完成");
  };

  const record = await runAgentEval({ runDir, invokeAgent });

  assert.equal(invocations, 1);
  assert.equal(record.passes, 1);
  assert.deepEqual(record.supplement_step_ids, []);
  assert.equal(record.eval_slice_supplement_path, undefined);
});

test("runAgentEval converts a repeated evidence request into an unable-to-judge final result", async () => {
  const { runDir } = makeRunDir();
  let invocations = 0;
  const invokeAgent = async () => {
    invocations += 1;
    return successfulResult(JSON.stringify({
      status: "needs_more_evidence",
      step_ids: [1],
      reason: invocations === 1 ? "Need step 1." : "Still need more.",
    }));
  };

  const record = await runAgentEval({ runDir, invokeAgent });

  assert.equal(invocations, 2);
  assert.equal(record.passes, 2);
  assert.match(readFileSync(record.output_path, "utf-8"), /交付结果：无法判断/);
  assert.match(readFileSync(record.output_path, "utf-8"), /等级：无法判断/);
});
