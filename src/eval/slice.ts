import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Attribution, CheckerResult, TrajectoryIR, Violation } from "../types/index.js";

export interface EvalSliceInput {
  runDir: string;
  traj: TrajectoryIR;
  checker: CheckerResult;
  attr: Attribution;
  flatMdPath: string;
  sourceTranscriptPath?: string;
}

export interface EvalSliceBounds {
  maxSliceChars: number;
  maxTaskChars: number;
  maxUserTurnChars: number;
  maxStepChars: number;
  maxStaticSummaryChars: number;
  maxHotspotSteps: number;
  maxSupplementSteps: number;
  maxSupplementStepChars: number;
  maxSupplementChars: number;
}

export interface EvalSliceRecord {
  markdownPath: string;
  metadataPath: string;
  selectedStepIds: number[];
  includedUserTurnIds: number[];
  finalStepId: number | null;
  sizeChars: number;
  bounds: EvalSliceBounds;
}

export interface EvalSliceSupplementRecord {
  markdownPath: string;
  requestedStepIds: number[];
  includedStepIds: number[];
  rejectedStepIds: number[];
  sizeChars: number;
}

interface FlatSection {
  kind: "task" | "user" | "assistant";
  id: number | null;
  heading: string;
  body: string;
}

interface TranscriptEntry {
  section: FlatSection;
  label: string;
  maxChars: number;
}

interface ToolHotspot {
  step?: unknown;
}

const BOUNDS: EvalSliceBounds = {
  maxSliceChars: 120_000,
  maxTaskChars: 8_000,
  maxUserTurnChars: 6_000,
  maxStepChars: 12_000,
  maxStaticSummaryChars: 20_000,
  maxHotspotSteps: 12,
  maxSupplementSteps: 6,
  maxSupplementStepChars: 20_000,
  maxSupplementChars: 120_000,
};

const SECTION_HEADING =
  /^(## Task \(first user message\)|## User Turn \d+ \(#U(\d+)\)|## Assistant Step \d+ \(#S(\d+), after #U\d+\)|## Session Stats|## Tool Efficiency Summary|## Attribution Summary(?: \(TrajRx\))?)\s*$/gm;

function readJsonOptional(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function truncateMiddle(value: string, maxChars: number): { text: string; truncated: boolean } {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return { text: trimmed, truncated: false };
  const marker = `\n\n[... ${trimmed.length - maxChars} chars omitted by deterministic bound ...]\n\n`;
  const available = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(available * 0.6);
  const tail = available - head;
  return {
    text: `${trimmed.slice(0, head)}${marker}${trimmed.slice(trimmed.length - tail)}`,
    truncated: true,
  };
}

function parseFlatSections(flat: string): FlatSection[] {
  const matches = [...flat.matchAll(SECTION_HEADING)];
  const sections: FlatSection[] = [];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    const heading = match[1]!;
    if (
      heading === "## Session Stats"
      || heading === "## Tool Efficiency Summary"
      || heading.startsWith("## Attribution Summary")
    ) break;
    const bodyStart = (match.index ?? 0) + match[0].length;
    const bodyEnd = matches[index + 1]?.index ?? flat.length;
    const kind = heading.startsWith("## Task")
      ? "task"
      : heading.startsWith("## User Turn")
        ? "user"
        : "assistant";
    const id = kind === "user"
      ? Number(match[2])
      : kind === "assistant"
        ? Number(match[3])
        : null;
    sections.push({
      kind,
      id,
      heading,
      body: flat.slice(bodyStart, bodyEnd).trim(),
    });
  }
  return sections;
}

function toStepId(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function addStep(target: number[], value: unknown, existing: Set<number>): void {
  const step = toStepId(value);
  if (step !== null && existing.has(step) && !target.includes(step)) target.push(step);
}

function highPriorityViolations(violations: Violation[]): Violation[] {
  return violations.filter((violation) => violation.severity === "high" || violation.severity === "critical");
}

function selectHotspotSteps(
  input: EvalSliceInput,
  toolEfficiency: Record<string, unknown> | null,
  existing: Set<number>
): number[] {
  const selected: number[] = [];
  addStep(selected, input.attr.critical_step, existing);

  for (const violation of highPriorityViolations(input.checker.violations ?? [])) {
    addStep(selected, violation.step_index, existing);
  }
  for (const violation of highPriorityViolations(input.attr.top_violations ?? [])) {
    addStep(selected, violation.step_index, existing);
  }

  const largest = Array.isArray(toolEfficiency?.largest_outputs)
    ? toolEfficiency.largest_outputs as ToolHotspot[]
    : [];
  const slowest = Array.isArray(toolEfficiency?.slowest)
    ? toolEfficiency.slowest as ToolHotspot[]
    : [];
  for (const hotspot of largest.slice(0, 3)) addStep(selected, hotspot.step, existing);
  for (const hotspot of slowest.slice(0, 3)) addStep(selected, hotspot.step, existing);

  return selected.slice(0, BOUNDS.maxHotspotSteps);
}

function compactToolEfficiency(value: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!value) return null;
  return {
    total_duration_ms: value.total_duration_ms ?? null,
    total_output_tokens: value.total_output_tokens ?? null,
    total_tool_calls: value.total_tool_calls ?? null,
    by_tool: value.by_tool ?? null,
    largest_outputs: Array.isArray(value.largest_outputs) ? value.largest_outputs.slice(0, 5) : [],
    slowest: Array.isArray(value.slowest) ? value.slowest.slice(0, 5) : [],
  };
}

function renderSection(section: FlatSection, maxChars: number): { text: string; truncated: boolean } {
  const bounded = truncateMiddle(section.body, maxChars);
  return {
    text: `${section.heading}\n\n${bounded.text || "(empty)"}`,
    truncated: bounded.truncated,
  };
}

function allocateContentBudgets(entries: TranscriptEntry[], totalChars: number): number[] {
  const headerChars = entries.reduce((total, entry) => total + entry.section.heading.length + 4, 0);
  let remaining = Math.max(0, totalChars - headerChars);
  const allocations = entries.map(() => 0);
  let active = entries.map((_, index) => index);

  while (remaining > 0 && active.length > 0) {
    const share = Math.max(1, Math.floor(remaining / active.length));
    let consumed = 0;
    const nextActive: number[] = [];
    for (const index of active) {
      const available = entries[index]!.maxChars - allocations[index]!;
      const amount = Math.min(available, share);
      allocations[index]! += amount;
      consumed += amount;
      if (allocations[index]! < entries[index]!.maxChars) nextActive.push(index);
    }
    if (consumed === 0) break;
    remaining -= consumed;
    active = nextActive;
  }
  return allocations;
}

function renderTranscriptEntries(
  entries: TranscriptEntry[],
  totalChars: number
): { sections: string[]; truncated: string[] } {
  const allocations = allocateContentBudgets(entries, totalChars);
  const sections: string[] = [];
  const truncated: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const rendered = renderSection(entry.section, allocations[index]!);
    sections.push(rendered.text);
    if (rendered.truncated) truncated.push(entry.label);
  }
  return { sections, truncated };
}

export function writeEvalSlice(input: EvalSliceInput): EvalSliceRecord {
  const flat = readFileSync(input.flatMdPath, "utf-8");
  const sections = parseFlatSections(flat);
  const task = sections.find((section) => section.kind === "task");
  const users = sections.filter((section) => section.kind === "user");
  const assistants = sections.filter((section) => section.kind === "assistant");
  const assistantById = new Map(
    assistants
      .filter((section): section is FlatSection & { id: number } => section.id !== null)
      .map((section) => [section.id, section])
  );
  const existingSteps = new Set(assistantById.keys());
  const finalStepId = assistants.at(-1)?.id ?? null;
  const toolEfficiencyRaw = readJsonOptional(join(input.runDir, "tool_efficiency.json"));
  const toolEfficiency =
    toolEfficiencyRaw && typeof toolEfficiencyRaw === "object" && !Array.isArray(toolEfficiencyRaw)
      ? toolEfficiencyRaw as Record<string, unknown>
      : null;
  const hotspotSteps = selectHotspotSteps(input, toolEfficiency, existingSteps);
  const selectedStepIds = [...hotspotSteps];
  addStep(selectedStepIds, finalStepId, existingSteps);
  selectedStepIds.sort((a, b) => a - b);

  const transcriptEntries: TranscriptEntry[] = [];
  if (task) transcriptEntries.push({ section: task, label: "task", maxChars: BOUNDS.maxTaskChars });
  for (const user of users) {
    transcriptEntries.push({
      section: user,
      label: `#U${user.id}`,
      maxChars: BOUNDS.maxUserTurnChars,
    });
  }
  for (const stepId of selectedStepIds) {
    const section = assistantById.get(stepId);
    if (section) {
      transcriptEntries.push({
        section,
        label: `#S${stepId}`,
        maxChars: BOUNDS.maxStepChars,
      });
    }
  }

  const staticSummary = truncateMiddle(
    JSON.stringify(
      {
        attribution: {
          primary_cause: input.attr.primary_cause,
          composite_causes: input.attr.composite_causes ?? [],
          confidence: input.attr.confidence,
          critical_step: input.attr.critical_step,
          explanation: input.attr.explanation,
          recommended_actions: input.attr.recommended_actions,
        },
        violations: {
          count: input.checker.violation_count,
          high_priority: highPriorityViolations(input.checker.violations ?? []).slice(0, 12),
          telemetry_summary: input.checker.telemetry_summary,
        },
        tool_efficiency: compactToolEfficiency(toolEfficiency),
        reconciliation: readJsonOptional(join(input.runDir, "reconcile", "reconciliation.json")),
      },
      null,
      2
    ),
    BOUNDS.maxStaticSummaryChars
  );
  const allStepIds = [...existingSteps].sort((a, b) => a - b);
  const omittedStepIds = allStepIds.filter((stepId) => !selectedStepIds.includes(stepId));
  const sourceIndex = {
    flat_transcript: input.flatMdPath,
    source_transcript: input.sourceTranscriptPath ?? input.traj.metadata.source_path ?? null,
    trajectory_ir: join(input.runDir, "trajectory_ir.json"),
    violations: join(input.runDir, "checker_results", "violations.json"),
    attribution: join(input.runDir, "judge_output", "attribution.json"),
    tool_efficiency: join(input.runDir, "tool_efficiency.json"),
    reconciliation: join(input.runDir, "reconcile", "reconciliation.json"),
  };

  const makeCoverage = (truncatedSections: string[]) => ({
    policy: "deterministic_bounded_slice_v1",
    task_included: Boolean(task),
    user_turn_ids: users.map((section) => section.id),
    selected_step_ids: selectedStepIds,
    omitted_step_ids: omittedStepIds,
    final_step_id: finalStepId,
    selection_reasons: {
      critical_step: input.attr.critical_step,
      high_priority_violation_steps: highPriorityViolations(input.checker.violations ?? [])
        .map((violation) => violation.step_index),
      largest_output_steps: Array.isArray(toolEfficiency?.largest_outputs)
        ? (toolEfficiency.largest_outputs as ToolHotspot[]).slice(0, 3).map((item) => item.step)
        : [],
      slowest_steps: Array.isArray(toolEfficiency?.slowest)
        ? (toolEfficiency.slowest as ToolHotspot[]).slice(0, 3).map((item) => item.step)
        : [],
    },
    truncated_sections: [
      ...truncatedSections,
      ...(staticSummary.truncated ? ["static_summary"] : []),
    ],
    bounds: BOUNDS,
  });
  const buildDocument = (sections: string[], coverage: ReturnType<typeof makeCoverage>) => [
      "# TrajRx Bounded Evaluation Slice",
      "",
      "This file is generated deterministically. Judge only from the included evidence.",
      "Do not read the full transcript or other artifacts during the first pass.",
      "",
      "## Coverage manifest",
      "",
      "```json",
      JSON.stringify(coverage, null, 2),
      "```",
      "",
      "## Static summary",
      "",
      "```json",
      staticSummary.text,
      "```",
      "",
      "## Transcript evidence",
      "",
      ...sections.flatMap((section) => [section, ""]),
      "## Source index",
      "",
      "```json",
      JSON.stringify(sourceIndex, null, 2),
      "```",
      "",
    ].join("\n");

  const emptyCoverage = makeCoverage([]);
  const fixedSize = buildDocument([], emptyCoverage).length;
  const documentLimit = BOUNDS.maxSliceChars - 1;
  let transcriptBudget = Math.max(0, documentLimit - fixedSize - 2_000);
  let rendered = renderTranscriptEntries(transcriptEntries, transcriptBudget);
  let coverage = makeCoverage(rendered.truncated);
  let document = buildDocument(rendered.sections, coverage);
  if (document.length > documentLimit) {
    transcriptBudget = Math.max(0, transcriptBudget - (document.length - documentLimit) - 1_000);
    rendered = renderTranscriptEntries(transcriptEntries, transcriptBudget);
    coverage = makeCoverage(rendered.truncated);
    document = buildDocument(rendered.sections, coverage);
  }
  if (document.length > documentLimit) {
    throw new Error(`Eval slice fixed metadata exceeds ${BOUNDS.maxSliceChars} characters`);
  }
  const boundedDocument = document + "\n";
  const markdownPath = join(input.runDir, "eval_slice.md");
  const metadataPath = join(input.runDir, "eval_slice.json");
  writeFileSync(markdownPath, boundedDocument, "utf-8");

  const record: EvalSliceRecord = {
    markdownPath,
    metadataPath,
    selectedStepIds,
    includedUserTurnIds: users.map((section) => section.id).filter((id): id is number => id !== null),
    finalStepId,
    sizeChars: boundedDocument.length,
    bounds: BOUNDS,
  };
  writeFileSync(
    metadataPath,
    JSON.stringify({ ...record, coverage, source_index: sourceIndex }, null, 2) + "\n",
    "utf-8"
  );
  return record;
}

export function writeEvalSliceSupplement(
  input: Pick<EvalSliceInput, "runDir" | "flatMdPath">,
  requestedStepIds: number[]
): EvalSliceSupplementRecord {
  const flat = readFileSync(input.flatMdPath, "utf-8");
  const assistants = parseFlatSections(flat).filter(
    (section): section is FlatSection & { id: number } =>
      section.kind === "assistant" && section.id !== null
  );
  const assistantById = new Map(assistants.map((section) => [section.id, section]));
  const normalized = [...new Set(requestedStepIds.map(toStepId).filter((id): id is number => id !== null))]
    .slice(0, BOUNDS.maxSupplementSteps);
  const includedStepIds = normalized.filter((stepId) => assistantById.has(stepId));
  const rejectedStepIds = normalized.filter((stepId) => !assistantById.has(stepId));
  const rendered = includedStepIds.map((stepId) =>
    renderSection(assistantById.get(stepId)!, BOUNDS.maxSupplementStepChars).text
  );
  const body = [
    "# TrajRx Evaluation Slice Supplement",
    "",
    "This is the only supplemental evidence pass. No third pass is allowed.",
    "",
    "## Request resolution",
    "",
    "```json",
    JSON.stringify({
      requested_step_ids: normalized,
      included_step_ids: includedStepIds,
      rejected_step_ids: rejectedStepIds,
      bounds: {
        max_steps: BOUNDS.maxSupplementSteps,
        max_step_chars: BOUNDS.maxSupplementStepChars,
        max_total_chars: BOUNDS.maxSupplementChars,
      },
    }, null, 2),
    "```",
    "",
    "## Supplemental transcript evidence",
    "",
    ...(rendered.length > 0
      ? rendered.flatMap((section) => [section, ""])
      : ["(No valid requested steps were found.)", ""]),
  ].join("\n");
  const boundedBody = truncateMiddle(body, BOUNDS.maxSupplementChars - 1).text + "\n";
  const markdownPath = join(input.runDir, "eval_slice_supplement.md");
  writeFileSync(markdownPath, boundedBody, "utf-8");
  return {
    markdownPath,
    requestedStepIds: normalized,
    includedStepIds,
    rejectedStepIds,
    sizeChars: boundedBody.length,
  };
}
