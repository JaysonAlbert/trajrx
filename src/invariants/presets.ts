import type { Category, Severity, TrajectoryIR, TrajectoryStep, Violation } from "../types/index.js";

type CheckFn = (traj: TrajectoryIR, steps: TrajectoryStep[]) => Violation[];

interface Invariant {
  invariant_id: string;
  category: Category;
  description: string;
  check: CheckFn;
}

function v(
  id: string,
  category: Category,
  step: number,
  severity: Severity,
  message: string,
  evidence: Record<string, unknown> = {}
): Violation {
  return { invariant_id: id, category, step_index: step, severity, message, evidence };
}

const invCtx001: CheckFn = (_t, steps) => {
  const out: Violation[] = [];
  for (const s of steps) {
    const tc = s.telemetry.tool_count;
    if (tc > 8) {
      out.push(v("INV-CTX-001", "context", s.index, "medium", `Step ${s.index} has ${tc} tool calls in one turn (threshold 8)`, { tool_count: tc }));
    }
  }
  return out;
};

const invCtx002: CheckFn = (_t, steps) => {
  const total = steps.reduce((n, s) => n + s.telemetry.read_count, 0);
  if (total > 40) {
    return [v("INV-CTX-002", "context", steps.at(-1)?.index ?? 0, "high", `Session has ${total} Read operations (threshold 40)`, { total_reads: total })];
  }
  return [];
};

const invCtx003: CheckFn = (traj, steps) => {
  if (!steps.length) return [];
  const userTurns = traj.metadata.user_turns ?? 1;
  const ratio = steps.length / Math.max(userTurns, 1);
  if (ratio > 12) {
    return [v("INV-CTX-003", "context", steps[Math.floor(steps.length / 2)]!.index, "high",
      `High assistant/user ratio ${ratio.toFixed(1)}:1 (${steps.length} steps / ${userTurns} user turns)`,
      { step_count: steps.length, user_turns: userTurns, ratio: Math.round(ratio * 100) / 100 })];
  }
  return [];
};

const invCtx004: CheckFn = (traj, steps) => {
  const userTurns = traj.metadata.user_turns ?? 0;
  let writes = 0;
  for (const s of steps) {
    for (const tn of s.telemetry.tool_names) {
      if (tn === "Write" || tn === "StrReplace") writes++;
    }
  }
  if (userTurns >= 20 && writes < 15) {
    return [v("INV-CTX-004", "context", steps.at(-1)?.index ?? 0, "high",
      `Scope creep: ${userTurns} user turns but only ${writes} write/edit ops`, { user_turns: userTurns, writes })];
  }
  return [];
};

const invTool001: CheckFn = (_t, steps) => {
  const patterns = new Map<string, number>();
  const firstStep = new Map<string, number>();
  for (const s of steps) {
    for (const pat of s.telemetry.grep_patterns) {
      patterns.set(pat, (patterns.get(pat) ?? 0) + 1);
      if (!firstStep.has(pat)) firstStep.set(pat, s.index);
    }
  }
  const out: Violation[] = [];
  for (const [pat, cnt] of patterns) {
    if (cnt >= 3) {
      out.push(v("INV-TOOL-001", "tool", firstStep.get(pat)!, "medium", `Grep pattern repeated ${cnt} times`, { pattern: pat.slice(0, 200), count: cnt }));
    }
  }
  return out;
};

const invTool002: CheckFn = (_t, steps) => {
  const cmds = new Map<string, number>();
  const firstStep = new Map<string, number>();
  for (const s of steps) {
    for (const cmd of s.telemetry.shell_cmds) {
      const norm = cmd.split(/\s+/).join(" ").slice(0, 500);
      cmds.set(norm, (cmds.get(norm) ?? 0) + 1);
      if (!firstStep.has(norm)) firstStep.set(norm, s.index);
    }
  }
  const out: Violation[] = [];
  for (const [cmd, cnt] of cmds) {
    if (cnt >= 2) {
      out.push(v("INV-TOOL-002", "tool", firstStep.get(cmd)!, "medium", `Shell command repeated ${cnt} times`, { command: cmd.slice(0, 300), count: cnt }));
    }
  }
  return out;
};

const invTool003: CheckFn = (_t, steps) => {
  let harnessRuns = 0;
  let firstIdx = 0;
  for (const s of steps) {
    for (const cmd of s.telemetry.shell_cmds) {
      if (cmd.includes("harness test run")) {
        harnessRuns++;
        if (!firstIdx) firstIdx = s.index;
      }
    }
  }
  if (harnessRuns >= 4) {
    return [v("INV-TOOL-003", "tool", firstIdx || 1, "high", `Harness test run invoked ${harnessRuns} times (trial-and-error loop)`, { harness_test_runs: harnessRuns })];
  }
  return [];
};

const invTool004: CheckFn = (_t, steps) => {
  const out: Violation[] = [];
  for (const s of steps) {
    for (const sub of s.substeps) {
      const dur = sub.execution?.duration_ms;
      if (dur != null && dur >= 120_000) {
        out.push(v("INV-TOOL-004", "tool", s.index, "high",
          `Slow tool ${sub.tool_name}: ${Math.round(dur / 1000)}s at substep ${sub.sub_index}`,
          { tool: sub.tool_name, duration_ms: dur, sub_index: sub.sub_index }));
      }
    }
  }
  return out;
};

const invTool005: CheckFn = (_t, steps) => {
  const out: Violation[] = [];
  for (const s of steps) {
    for (const sub of s.substeps) {
      const tokens = sub.execution?.output_tokens ?? 0;
      if (tokens >= 50_000) {
        out.push(v("INV-TOOL-005", "tool", s.index, "high",
          `Bloated tool output ${sub.tool_name}: ~${tokens.toLocaleString()} tokens`,
          { tool: sub.tool_name, output_tokens: tokens, sub_index: sub.sub_index }));
      }
    }
  }
  return out;
};

const invTool006: CheckFn = (_t, steps) => {
  const totalMs = steps.reduce((n, s) => n + (s.telemetry.tool_duration_ms ?? 0), 0);
  if (totalMs >= 30 * 60_000) {
    return [v("INV-TOOL-006", "tool", steps.at(-1)?.index ?? 0, "high",
      `Session tool wall time ~${Math.round(totalMs / 60000)} min (threshold 30 min)`,
      { total_tool_duration_ms: totalMs })];
  }
  return [];
};

const invTool007: CheckFn = (_t, steps) => {
  let readTokens = 0;
  let readCount = 0;
  for (const s of steps) {
    for (const sub of s.substeps) {
      if (sub.tool_name === "Read") {
        readTokens += sub.execution?.output_tokens ?? 0;
        readCount++;
      }
    }
  }
  const avg = readCount ? readTokens / readCount : 0;
  if (readCount >= 20 && avg >= 5000) {
    return [v("INV-TOOL-007", "tool", steps[Math.floor(steps.length / 2)]!.index, "medium",
      `Read output bloat: avg ~${Math.round(avg).toLocaleString()} tokens across ${readCount} reads`,
      { avg_read_tokens: Math.round(avg), read_count: readCount })];
  }
  return [];
};

const invMcp001: CheckFn = (_t, steps) => {
  const totalTools = steps.reduce((n, s) => n + s.telemetry.tool_count, 0);
  const mcpCalls = steps.reduce((n, s) => n + s.telemetry.mcp_count, 0);
  if (totalTools > 50 && mcpCalls / Math.max(totalTools, 1) > 0.3) {
    return [v("INV-MCP-001", "mcp", steps.at(-1)?.index ?? 0, "medium",
      `MCP calls ${mcpCalls}/${totalTools} (${Math.round(100 * mcpCalls / totalTools)}%) — MCP-heavy exploration`,
      { mcp_calls: mcpCalls, total_tools: totalTools })];
  }
  return [];
};

const invMcp002: CheckFn = (_t, steps) => {
  const mcpCalls = steps.reduce((n, s) => n + s.telemetry.mcp_count, 0);
  if (mcpCalls > 100) {
    return [v("INV-MCP-002", "mcp", steps[Math.floor(steps.length / 2)]!.index, "high",
      `Excessive MCP invocations: ${mcpCalls} (possible log/query thrashing)`, { mcp_calls: mcpCalls })];
  }
  return [];
};

const invSkill001: CheckFn = (_t, steps) => {
  const skillRead = steps.some((s) => s.telemetry.skill_reads.length > 0);
  const totalRead = steps.reduce((n, s) => n + s.telemetry.read_count, 0);
  const totalGrep = steps.reduce((n, s) => n + s.telemetry.grep_count, 0);
  let writeCount = 0;
  for (const s of steps) {
    for (const tn of s.telemetry.tool_names) {
      if (tn === "Write" || tn === "StrReplace") writeCount++;
    }
  }
  if (skillRead && totalRead + totalGrep > 30 && writeCount < 3) {
    return [v("INV-SKILL-001", "skill", steps.at(-1)?.index ?? 0, "medium",
      `Skill loaded but exploration-heavy (${totalRead} reads, ${totalGrep} greps, ${writeCount} writes)`,
      { reads: totalRead, greps: totalGrep, writes: writeCount })];
  }
  return [];
};

const invSkill002: CheckFn = (traj, steps) => {
  const instr = (traj.instruction ?? "").toLowerCase();
  if (!instr.includes("harness")) return [];
  const readHarness = steps.some((s) =>
    s.telemetry.read_paths.some((p) => p.includes("harness/SKILL.md")) ||
    s.telemetry.skill_reads.some((p) => p.includes("harness/SKILL.md") || p.toLowerCase().includes("skills/harness")) ||
    s.telemetry.shell_cmds.some((c) => c.includes("harness/SKILL.md") || c.includes("skills/harness"))
  );
  if (!readHarness) {
    return [v("INV-SKILL-002", "skill", 1, "low", "Task mentions harness but harness SKILL.md was not read early", { instruction_snippet: instr.slice(0, 200) })];
  }
  return [];
};

const invCodex001: CheckFn = (traj, steps) => {
  const eff = traj.metadata.tool_efficiency as { background_sessions?: Array<{ session_id: number; poll_count: number; total_wall_ms: number; aggregated_ms?: number; command: string; first_step?: number }> } | undefined;
  const sessions = eff?.background_sessions ?? [];
  const out: Violation[] = [];
  for (const bg of sessions) {
    const wall = bg.aggregated_ms ?? bg.total_wall_ms;
    if (bg.poll_count >= 3 && wall >= 60_000) {
      out.push(v("INV-CODEX-001", "tool", bg.first_step ?? steps[0]?.index ?? 1, "high",
        `Background exec session ${bg.session_id} polled ${bg.poll_count} times (~${Math.round(wall / 1000)}s wall)`,
        { session_id: bg.session_id, poll_count: bg.poll_count, total_wall_ms: wall, command: bg.command.slice(0, 200) }));
    }
  }
  return out;
};

const invCodex002: CheckFn = (traj, steps) => {
  const eff = traj.metadata.tool_efficiency as { thinking_gaps_ms?: Array<{ after_step: number; gap_ms: number; label: string }> } | undefined;
  const gaps = eff?.thinking_gaps_ms ?? [];
  const out: Violation[] = [];
  for (const gap of gaps) {
    if (gap.gap_ms >= 120_000) {
      out.push(v("INV-CODEX-002", "context", gap.after_step, "high",
        `Long idle gap ${Math.round(gap.gap_ms / 1000)}s before next step (model/tool wait)`,
        { gap_ms: gap.gap_ms, label: gap.label.slice(0, 200) }));
    }
  }
  return out;
};

const invCodex003: CheckFn = (_t, steps) => {
  let discovery = 0;
  let envUp = 0;
  let firstDiscovery = 0;
  for (const s of steps.slice(0, 15)) {
    for (const cmd of s.telemetry.shell_cmds) {
      const lower = cmd.toLowerCase();
      if (/^(find|rg|grep|ls|sed|cat)\s/.test(lower) || lower.includes(" --help") || lower.includes("worktree list")) {
        discovery++;
        if (!firstDiscovery) firstDiscovery = s.index;
      }
      if (lower.includes("harness env up") || lower.includes("pnpm install") || lower.includes("pnpm run serve")) {
        envUp++;
      }
    }
  }
  if (discovery >= 8 && envUp === 0) {
    return [v("INV-CODEX-003", "context", firstDiscovery || 1, "medium",
      `Extended discovery (${discovery} search/help cmds) before environment bootstrap`,
      { discovery_cmds: discovery, env_up_cmds: envUp })];
  }
  return [];
};

export const PRESET_INVARIANTS: Invariant[] = [
  { invariant_id: "INV-CTX-001", category: "context", description: "Too many tools per step", check: invCtx001 },
  { invariant_id: "INV-CTX-002", category: "context", description: "Excessive Read ops", check: invCtx002 },
  { invariant_id: "INV-CTX-003", category: "context", description: "High assistant/user ratio", check: invCtx003 },
  { invariant_id: "INV-CTX-004", category: "context", description: "Scope creep low delivery", check: invCtx004 },
  { invariant_id: "INV-TOOL-001", category: "tool", description: "Repeated Grep", check: invTool001 },
  { invariant_id: "INV-TOOL-002", category: "tool", description: "Repeated Shell", check: invTool002 },
  { invariant_id: "INV-TOOL-003", category: "tool", description: "Harness retry loop", check: invTool003 },
  { invariant_id: "INV-TOOL-004", category: "tool", description: "Slow single tool execution", check: invTool004 },
  { invariant_id: "INV-TOOL-005", category: "tool", description: "Bloated tool output", check: invTool005 },
  { invariant_id: "INV-TOOL-006", category: "tool", description: "Excessive total tool wall time", check: invTool006 },
  { invariant_id: "INV-TOOL-007", category: "tool", description: "Read output bloat", check: invTool007 },
  { invariant_id: "INV-MCP-001", category: "mcp", description: "MCP-heavy session", check: invMcp001 },
  { invariant_id: "INV-MCP-002", category: "mcp", description: "MCP thrashing", check: invMcp002 },
  { invariant_id: "INV-SKILL-001", category: "skill", description: "Skill read but over-explore", check: invSkill001 },
  { invariant_id: "INV-SKILL-002", category: "skill", description: "Missing harness skill", check: invSkill002 },
  { invariant_id: "INV-CODEX-001", category: "tool", description: "Codex background exec polling", check: invCodex001 },
  { invariant_id: "INV-CODEX-002", category: "context", description: "Codex long thinking gap", check: invCodex002 },
  { invariant_id: "INV-CODEX-003", category: "context", description: "Codex discovery before bootstrap", check: invCodex003 },
];

export function exportStaticInvariants() {
  return PRESET_INVARIANTS.map((inv) => ({
    invariant_id: inv.invariant_id,
    category: inv.category,
    description: inv.description,
  }));
}
