export type Severity = "low" | "medium" | "high" | "critical";
export type Category = "context" | "tool" | "mcp" | "skill" | "unknown";

export interface Violation {
  invariant_id: string;
  category: Category;
  step_index: number;
  severity: Severity;
  message: string;
  evidence: Record<string, unknown>;
}

export interface StepTelemetry {
  user_turn: number;
  tool_count: number;
  mcp_count: number;
  shell_count: number;
  read_count: number;
  grep_count: number;
  assistant_chars: number;
  tool_names: string[];
  mcp_servers: string[];
  shell_cmds: string[];
  grep_patterns: string[];
  read_paths: string[];
  skill_reads: string[];
}

export interface Substep {
  sub_index: number;
  role: string;
  content: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

export interface TrajectoryStep {
  index: number;
  telemetry: StepTelemetry;
  substeps: Substep[];
}

export interface TrajectoryIR {
  trajectory_id: string;
  source: string;
  instruction: string;
  metadata: {
    source_path?: string;
    event_count?: number;
    step_count?: number;
    user_turns?: number;
  };
  steps: TrajectoryStep[];
}

export interface RawTrajectory {
  trajectory_id: string;
  instruction: string;
  events: CursorEvent[];
  _source_path?: string;
  _format?: string;
}

export interface CursorEvent {
  role?: string;
  message?: {
    content?: Array<{
      type?: string;
      text?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
  };
}

export interface CheckerResult {
  trajectory_id: string;
  violations: Violation[];
  violation_count: number;
  telemetry_summary: Record<string, unknown>;
}

export interface Attribution {
  trajectory_id: string;
  primary_cause: string;
  composite_causes?: string[];
  confidence: number;
  critical_step: number | null;
  category_scores: Record<string, number>;
  violations_by_category: Record<string, number>;
  top_violations: Violation[];
  explanation: string;
  recommended_actions: string[];
  telemetry_summary?: Record<string, unknown>;
}
