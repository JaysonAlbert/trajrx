import assert from "node:assert/strict";
import test from "node:test";

import { enrichCodexSession } from "../dist/enrich/codexToolMetrics.js";
import { buildAnalysisReport } from "../dist/export/analysisReport.js";
import { buildInitialEvalPrompt } from "../dist/eval/prompt.js";
import { checkTrajectory } from "../dist/invariants/checker.js";
import { buildStepTelemetry, extractCodexStepFields } from "../dist/ir/stepTelemetry.js";
import { mergeAgentEvalSummary } from "../dist/pipeline.js";

function emptyTelemetry(userTurn = 1) {
  return {
    user_turn: userTurn,
    tool_count: 0,
    mcp_count: 0,
    shell_count: 0,
    read_count: 0,
    grep_count: 0,
    assistant_chars: 0,
    tool_duration_ms: 0,
    tool_output_tokens: 0,
    tool_names: [],
    mcp_servers: [],
    shell_cmds: [],
    grep_patterns: [],
    read_paths: [],
    skill_reads: [],
  };
}

function shellSubstep(index, command) {
  return {
    sub_index: 1,
    role: "tool:Shell",
    content: command,
    tool_name: "Shell",
    tool_input: {
      cmd: command,
      _codex_tool: "exec_command",
    },
    execution: {
      duration_ms: index,
      duration_source: "terminal",
      output_chars: 10,
      output_tokens: 3,
      output_source: "terminal_output",
    },
  };
}

test("Codex telemetry extraction returns fresh arrays per tool call", () => {
  const first = extractCodexStepFields(shellSubstep(1, "echo first"));
  const second = extractCodexStepFields(shellSubstep(2, "echo second"));

  assert.deepEqual(first.shell_cmds, ["echo first"]);
  assert.deepEqual(second.shell_cmds, ["echo second"]);
  assert.notEqual(first.shell_cmds, second.shell_cmds);
});

test("Codex observed Shell, Grep, and Read classifications are mutually exclusive", () => {
  const grep = extractCodexStepFields({
    ...shellSubstep(1, "rg -n 'needle' src"),
    tool_name: "Grep",
    role: "tool:Grep",
    tool_input: {
      cmd: "rg -n 'needle' src",
      pattern: "needle",
      _codex_tool: "exec_command",
    },
  });
  const read = extractCodexStepFields({
    ...shellSubstep(2, "sed -n '1,20p' README.md"),
    tool_name: "Read",
    role: "tool:Read",
    tool_input: {
      cmd: "sed -n '1,20p' README.md",
      path: "README.md",
      _codex_tool: "exec_command",
    },
  });

  assert.deepEqual(grep, {
    shell_cmds: [],
    grep_patterns: ["needle"],
    read_paths: [],
    skill_reads: [],
    mcp_servers: [],
  });
  assert.deepEqual(read, {
    shell_cmds: [],
    grep_patterns: [],
    read_paths: ["README.md"],
    skill_reads: [],
    mcp_servers: [],
  });
});

test("step call counters use observed tool categories while feature arrays retain embedded operations", () => {
  const grep = {
    ...shellSubstep(1, "rg -n 'needle' src"),
    tool_name: "Grep",
    role: "tool:Grep",
    tool_input: {
      cmd: "rg -n 'needle' src",
      pattern: "needle",
      _codex_tool: "exec_command",
    },
  };
  const shell = shellSubstep(2, "docker logs service | rg 'ERROR'");

  const telemetry = buildStepTelemetry([grep, shell], 1, extractCodexStepFields);

  assert.equal(telemetry.tool_count, 2);
  assert.equal(telemetry.shell_count, 1);
  assert.equal(telemetry.grep_count, 1);
  assert.deepEqual(telemetry.grep_patterns, ["needle", "ERROR"]);
});

test("thinking gaps exclude time between different user turns", () => {
  const session = {
    trajectory_id: "gap-test",
    instruction: "test gaps",
    raw_event_count: 0,
    turns: [
      {
        user_message: "first",
        timestamp: "2026-07-31T00:00:00.000Z",
        steps: [
          { commentary: "one", timestamp: "2026-07-31T00:00:10.000Z", tools: [] },
          { commentary: "two", timestamp: "2026-07-31T00:03:10.000Z", tools: [] },
        ],
      },
      {
        user_message: "second",
        timestamp: "2026-07-31T01:00:00.000Z",
        steps: [
          { commentary: "three", timestamp: "2026-07-31T01:01:00.000Z", tools: [] },
        ],
      },
    ],
  };

  const { sessionToolStats } = enrichCodexSession(session);

  assert.deepEqual(
    sessionToolStats.thinking_gaps_ms.map(({ after_step, gap_ms }) => ({ after_step, gap_ms })),
    [{ after_step: 1, gap_ms: 180_000 }],
  );
});

test("user-turn count without mutation telemetry is not labeled scope creep", () => {
  const traj = {
    trajectory_id: "conversation-test",
    source: "codex",
    instruction: "Explain the system",
    metadata: { user_turns: 25, step_count: 1 },
    steps: [{ index: 1, telemetry: emptyTelemetry(), substeps: [] }],
  };

  const checker = checkTrajectory(traj);

  assert.equal(checker.violations.some((violation) => violation.invariant_id === "INV-CTX-004"), false);
});

test("same-turn timing gaps produce one neutral medium diagnostic instead of per-gap high violations", () => {
  const traj = {
    trajectory_id: "gap-invariant-test",
    source: "codex",
    instruction: "Inspect timing",
    metadata: {
      user_turns: 1,
      step_count: 1,
      tool_efficiency: {
        thinking_gaps_ms: [
          { after_step: 1, gap_ms: 130_000, label: "first" },
          { after_step: 2, gap_ms: 180_000, label: "second" },
        ],
      },
    },
    steps: [{ index: 1, telemetry: emptyTelemetry(), substeps: [] }],
  };

  const gaps = checkTrajectory(traj).violations.filter(
    (violation) => violation.invariant_id === "INV-CODEX-002",
  );

  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].severity, "medium");
  assert.match(gaps[0].message, /2 long same-turn gaps/);
  assert.doesNotMatch(gaps[0].message, /model\/tool wait|idle/i);
});

test("default analysis report is bounded, omits full command dumps, and redacts credentials", () => {
  const steps = Array.from({ length: 40 }, (_, offset) => {
    const index = offset + 1;
    const command =
      `DB_URL='mysql+pymysql://report_user:supersecret@db.example.test:3306/app' ` +
      `curl -H 'Authorization: Bearer token-${index}' https://example.test/${index} ` +
      `--label unique-command-${index}`;
    return {
      index,
      telemetry: {
        ...emptyTelemetry(),
        tool_count: 1,
        shell_count: 1,
        tool_names: ["Shell"],
        shell_cmds: [command],
      },
      substeps: [shellSubstep(index, command)],
    };
  });
  const traj = {
    trajectory_id: "report-test",
    source: "codex",
    instruction: "Inspect command efficiency",
    metadata: { user_turns: 1, step_count: steps.length },
    steps,
  };
  const checker = checkTrajectory(traj);
  const attr = {
    trajectory_id: traj.trajectory_id,
    primary_cause: "tool",
    confidence: 0.8,
    critical_step: 1,
    category_scores: { tool: 1 },
    violations_by_category: { tool: 1 },
    top_violations: checker.violations.slice(0, 5),
    explanation: "Repeated commands",
    recommended_actions: [],
  };

  const report = buildAnalysisReport({ traj, checker, attr });

  assert.doesNotMatch(report, /^### .*完整|^### 逐次调用/m);
  assert.doesNotMatch(report, /supersecret|token-1/);
  assert.match(report, /command_breakdown\.json/);
  assert.ok(report.length < 25_000, `report should stay compact, got ${report.length} chars`);
});

test("agent evaluation prompt excludes user idle and user-requested scope changes from inefficiency evidence", () => {
  const prompt = buildInitialEvalPrompt("/tmp/eval_slice.md");

  assert.match(prompt, /user idle.*must not affect the efficiency grade/i);
  assert.match(prompt, /explicitly requested by the user.*not agent scope creep/i);
  assert.match(prompt, /Do not recommend a CLI flag.*evidence/i);
});

test("agent-eval-only summary retains static findings and existing artifacts", () => {
  const previous = {
    run_name: "run",
    run_dir: "/tmp/run",
    session_id: "session",
    session_title: "联调环境",
    source_transcript: "/tmp/source.jsonl",
    format: "codex",
    started_at: "2026-07-30T00:00:00.000Z",
    finished_at: "2026-07-30T00:01:00.000Z",
    duration_ms: 60_000,
    events: 100,
    steps: 10,
    violations: 44,
    primary_cause: "tool",
    confidence: 0.76,
    reconcile_verdict: "consistent",
    session_wall_sec: 1000,
    session_active_wall_sec: 300,
    user_idle_sec: 700,
    tool_time_sec: 50,
    output_tokens: 1234,
    artifacts: [{ label: "trajectory_ir.json", path: "/tmp/run/trajectory_ir.json" }],
    log_path: "/tmp/run/run.log",
  };
  const current = {
    ...previous,
    session_title: undefined,
    violations: 0,
    primary_cause: undefined,
    confidence: undefined,
    reconcile_verdict: undefined,
    session_wall_sec: undefined,
    session_active_wall_sec: undefined,
    user_idle_sec: undefined,
    tool_time_sec: undefined,
    output_tokens: undefined,
    duration_ms: 42_000,
    artifacts: [{ label: "agent-evaluation.md", path: "/tmp/run/agent-evaluation.md" }],
    agent_eval: {
      enabled: true,
      cli: "cursor",
      model: "auto",
      duration_ms: 41_000,
      output_path: "/tmp/run/agent-evaluation.md",
    },
  };

  const merged = mergeAgentEvalSummary(
    current,
    previous,
    { trajectory_id: "session", violation_count: 43, violations: [] },
    {
      trajectory_id: "session",
      primary_cause: "compound",
      confidence: 0.81,
      critical_step: 1,
      category_scores: {},
      violations_by_category: {},
      top_violations: [],
      explanation: "",
      recommended_actions: [],
    },
  );

  assert.equal(merged.duration_ms, 42_000);
  assert.equal(merged.violations, 43);
  assert.equal(merged.primary_cause, "compound");
  assert.equal(merged.confidence, 0.81);
  assert.equal(merged.session_title, "联调环境");
  assert.equal(merged.session_wall_sec, 1000);
  assert.deepEqual(
    merged.artifacts.map((artifact) => artifact.path),
    ["/tmp/run/trajectory_ir.json", "/tmp/run/agent-evaluation.md"],
  );
});
