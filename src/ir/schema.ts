import type { TrajectoryIR } from "../types/index.js";

export function validateIr(ir: TrajectoryIR): void {
  if (!ir.trajectory_id || !Array.isArray(ir.steps)) {
    throw new Error("IR must have trajectory_id and steps");
  }
  for (const step of ir.steps) {
    if (typeof step.index !== "number") throw new Error("Step missing index");
    for (const sub of step.substeps ?? []) {
      for (const k of ["sub_index", "role", "content"] as const) {
        if ((sub as unknown as Record<string, unknown>)[k] === undefined) {
          throw new Error(`Substep missing ${k}`);
        }
      }
    }
  }
}

export function isIr(data: unknown[]): data is TrajectoryIR[] {
  if (!data.length) return false;
  try {
    validateIr(data[0] as TrajectoryIR);
    return true;
  } catch {
    return false;
  }
}
