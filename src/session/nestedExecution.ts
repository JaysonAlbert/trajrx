/** Observations of emitted inner results, never an inferred population of JS calls. */
import type { BoundedList } from "./turnAnalysis.js";

type Outcome = "failed" | "succeeded" | "unknown";
export interface NestedResult {
  parent_sequence: number;
  path: string;
  outcome: Outcome;
  signals: string[];
  interpretation: "unclassified";
}
export interface NestedExecutionEvidence {
  coverage: "observed_only";
  observed_result_count: number;
  failed_count: number;
  succeeded_count: number;
  unknown_count: number;
  results: BoundedList<NestedResult>;
  unknown_wrappers: BoundedList<{ parent_sequence: number; reason: string }>;
  error_hints: BoundedList<{ parent_sequence: number; signal: string }>;
}
export interface ExecutionOutput { sequence: number; name: string; output: unknown }

export function nestedExecution(outputs: ExecutionOutput[], top: number): NestedExecutionEvidence {
  const results: NestedResult[] = [];
  const unknown: Array<{ parent_sequence: number; reason: string }> = [];
  const hints: Array<{ parent_sequence: number; signal: string }> = [];
  for (const call of outputs) {
    if (!/^(?:functions\.)?(?:exec|wait)$/.test(call.name)) continue;
    if (!call.name.startsWith("functions.") && !hasScriptEnvelope(call.output)) continue;
    let unparsed = false;
    const before = results.length;
    const add = (path: string, outcome: Outcome, signals: string[]) => {
      results.push({ parent_sequence: call.sequence, path, outcome, signals, interpretation: "unclassified" });
    };
    const hint = (text: string): void => {
      for (const [signal, pattern] of [
        ["TypeError", /\bTypeError\s*:/],
        ["HTTP error", /\bHTTP\s+[45]\d\d\b/],
        ["unknown command", /\b(?:unknown command|unrecognized arguments|invalid choice)\b/i],
      ] as const) {
        if (pattern.test(text) && !hints.some(h => h.parent_sequence === call.sequence && h.signal === signal)) {
          hints.push({ parent_sequence: call.sequence, signal });
        }
      }
    };
    const inspect = (value: unknown, path: string, resultBoundary = false): void => {
      if (Array.isArray(value)) {
        value.forEach((item, i) => inspect(item, `${path}[${i}]`));
        return;
      }
      const object = asObject(value);
      if (object) {
        // An allSettled rejection is one result, irrespective of its reason payload.
        if (object.status === "rejected") { add(path, "failed", ["allSettled:rejected"]); return; }
        if (object.status === "fulfilled") { inspect(object.value, `${path}.value`, true); return; }
        if (typeof object.output === "string") hint(object.output);
        const signals: string[] = [];
        let failed = false;
        for (const key of ["exit_code", "exitCode", "returncode", "return_code"]) {
          if (typeof object[key] === "number" && Number.isInteger(object[key])) {
            signals.push(`${key}:${object[key]}`);
            failed ||= object[key] !== 0;
          }
        }
        for (const key of ["isError", "is_error"]) {
          if (typeof object[key] === "boolean") {
            signals.push(`${key}:${object[key]}`);
            failed ||= object[key] === true;
          }
        }
        if (signals.length) {
          add(path, failed ? "failed" : "succeeded", signals);
          return; // stdout/content are data, including duplicate structuredContent.
        }
        if (resultBoundary) { add(path, "unknown", ["missing_or_invalid_status"]); return; }
        if (typeof object.text === "string" && ["input_text", "text"].includes(String(object.type))) {
          inspect(object.text, `${path}.text`);
        } else if ("result" in object) {
          inspect(object.result, `${path}.result`);
        } else if ("content" in object) {
          inspect(object.content, `${path}.content`);
        } else if (["exit_code", "exitCode", "returncode", "return_code", "isError", "is_error", "output", "session_id"].some(key => key in object)) {
          add(path, "unknown", ["missing_or_invalid_status"]);
        } else {
          unparsed = true; // A printed business/config object is not an operation.
        }
        return;
      }
      if (typeof value !== "string") {
        if (resultBoundary) add(path, "unknown", ["missing_or_invalid_result"]);
        else unparsed = true;
        return;
      }
      let text = value.trim();
      if (/^Script (?:completed|failed|running with cell ID)/i.test(text)) {
        const marker = /\nOutput:\s*\n?/.exec(text);
        text = marker ? text.slice(marker.index + marker[0].length).trim() : "";
        if (!text) return; // Desktop may emit the actual results in separate text blocks.
      }
      hint(text);
      // Printed command envelopes from exec_command/write_stdin: stop at stdout.
      if (/^(?:Chunk ID:|Process exited with code|Wall time:)/.test(text)) {
        const header = text.split(/\n(?:Final output|Output):/)[0]!;
        const exit = /(?:^|\n)Process exited with code (-?\d+)\s*(?:\n|$)/.exec(header);
        if (exit) { add(path, Number(exit[1]) === 0 ? "succeeded" : "failed", [`exit_code:${exit[1]}`]); return; }
        if (/Process running with session ID/.test(header)) { add(path, "unknown", ["pending_session"]); return; }
      }
      const parsed = parseEmittedJson(text);
      if (parsed.values.length) parsed.values.forEach((item, i) => inspect(item, `${path}.json[${i}]`));
      if (parsed.unparsed || !parsed.values.length) unparsed = true;
    };
    if (call.output === null) unparsed = true;
    else inspect(call.output, "$");
    if (unparsed || before === results.length) unknown.push({ parent_sequence: call.sequence, reason: "missing_or_unparsed_output" });
  }
  return {
    coverage: "observed_only", observed_result_count: results.length,
    failed_count: results.filter(r => r.outcome === "failed").length,
    succeeded_count: results.filter(r => r.outcome === "succeeded").length,
    unknown_count: results.filter(r => r.outcome === "unknown").length,
    results: bounded(results, top), unknown_wrappers: bounded(unknown, top), error_hints: bounded(hints, top),
  };
}

function hasScriptEnvelope(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasScriptEnvelope);
  const object = asObject(value);
  if (object) return hasScriptEnvelope(object.text ?? object.content);
  return typeof value === "string" && /^Script (?:completed|failed|running with cell ID)/i.test(value.trim());
}

/** Decode whole values printed at line boundaries; never search inside a JSON string. */
function parseEmittedJson(text: string): { values: unknown[]; unparsed: boolean } {
  const values: unknown[] = [];
  let rest = text.trim();
  while (rest) {
    if (!["{", "["].includes(rest[0]!)) return { values, unparsed: true };
    let depth = 0;
    let quoted = false;
    let escaped = false;
    let end = -1;
    for (let i = 0; i < rest.length; i++) {
      const c = rest[i]!;
      if (quoted) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === "\"") quoted = false;
      } else if (c === "\"") quoted = true;
      else if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        depth--;
        if (!depth) { end = i + 1; break; }
      }
    }
    if (end < 0) return { values, unparsed: true };
    try { values.push(JSON.parse(rest.slice(0, end))); }
    catch { return { values, unparsed: true }; }
    const tail = rest.slice(end);
    if (tail.trim() && !/^\s*\n/.test(tail)) return { values, unparsed: true };
    rest = tail.trim();
  }
  return { values, unparsed: false };
}
function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function bounded<T>(items: T[], top: number): BoundedList<T> {
  const selected = items.slice(0, top);
  return { total: items.length, returned: selected.length, truncated: items.length > selected.length, items: selected };
}
