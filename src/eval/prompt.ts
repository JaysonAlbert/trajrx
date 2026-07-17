export interface SupplementRequest {
  status: "needs_more_evidence";
  step_ids: number[];
  reason: string;
}

const OUTPUT_CONTRACT = [
  "# Agent Evaluation — <short session id>",
  "",
  "## 任务与结果",
  "- 任务：<1-2 sentences>",
  "- 交付结果：完成 | 部分完成 | 未完成 | 无法判断",
  "",
  "## 效率",
  "- 等级：高 | 中 | 低",
  "- 主因：context | tool | mcp | skill | none | compound",
  "- 证据：<cite #SN/#UN and bounded metrics>",
  "",
  "Efficiency rubric:",
  "- 高：没有实质性可避免浪费，或浪费很小。",
  "- 中：存在局部可避免浪费，但没有主导整个执行。",
  "- 低：可避免的工具/上下文浪费明显主导执行，重复失败，或阻碍交付。",
  "- 任务未完成本身不等于低效率；必须判断执行成本和可避免浪费。",
  "",
  "## 与静态结论对照",
  "- 明确说明是否同意 static primary_cause；分歧时解释证据。",
  "- 必须说明 telemetry 是否存在 conflict，以及采用哪一组计数。",
  "",
  "## 改进建议",
  "1. <only actionable, evidence-backed changes>",
  "",
  "## artifact 索引",
  "- <slice paths used>",
].join("\n");

const TELEMETRY_GUARDRAILS = [
  "Telemetry evidence rules (mandatory):",
  "- `literal_observed_calls` is the authority for actual invocation counts.",
  "- Never report `heuristic_feature_counters` as literal tool-call counts.",
  "- If `telemetry_reliability.contradictions` is non-empty, resolve every telemetry conflict explicitly in `与静态结论对照`.",
  "- Heuristic counters may support anomaly detection, but they must not determine the efficiency grade.",
  "- Do not collapse a material secondary cause merely because static `primary_cause` names one category; use `compound` when the observed evidence supports it.",
].join("\n");

function stripFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  return match ? match[1]!.trim() : trimmed;
}

export function parseSupplementRequest(text: string): SupplementRequest | null {
  let value: unknown;
  try {
    value = JSON.parse(stripFence(text));
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.status !== "needs_more_evidence") return null;
  if (!Array.isArray(candidate.step_ids) || typeof candidate.reason !== "string") return null;
  const stepIds = candidate.step_ids.filter(
    (step): step is number => typeof step === "number" && Number.isInteger(step) && step > 0
  );
  if (stepIds.length === 0) return null;
  return {
    status: "needs_more_evidence",
    step_ids: stepIds,
    reason: candidate.reason.trim(),
  };
}

export function buildInitialEvalPrompt(evalSlicePath: string): string {
  return [
    "Run a TrajRx agent-evaluation job using bounded evidence.",
    "",
    `Read ${evalSlicePath} completely.`,
    "Do not read the full transcript or any other artifact in this pass.",
    "",
    TELEMETRY_GUARDRAILS,
    "",
    "If the slice is sufficient, output ONLY the final Markdown document using this contract:",
    "",
    "```markdown",
    OUTPUT_CONTRACT,
    "```",
    "",
    "If and only if a material conclusion cannot be judged from the slice, output ONLY one JSON object:",
    '{"status":"needs_more_evidence","step_ids":[1,2],"reason":"specific missing evidence"}',
    "",
    "Request only concrete Assistant step IDs listed as omitted in the coverage manifest.",
    "At most six steps may be requested. Do not output Markdown together with the JSON.",
    "Write the final evaluation in Chinese and stay concise.",
  ].join("\n");
}

export function buildSupplementEvalPrompt(
  evalSlicePath: string,
  supplementPath: string,
  requestReason: string
): string {
  return [
    "Complete the TrajRx agent-evaluation using the bounded evidence files.",
    "",
    `Read ${evalSlicePath} completely.`,
    `Read ${supplementPath} completely.`,
    `The first pass requested more evidence because: ${requestReason || "(reason not provided)"}`,
    "",
    "No third pass is allowed. You MUST now output ONLY the final Markdown document.",
    "If evidence is still insufficient, set `交付结果：无法判断` and explain the missing evidence.",
    "Do not read the full transcript or other artifacts.",
    "",
    TELEMETRY_GUARDRAILS,
    "",
    "Use this exact contract:",
    "",
    "```markdown",
    OUTPUT_CONTRACT,
    "```",
    "",
    "Write in Chinese and stay concise.",
  ].join("\n");
}

export function buildUnableToJudgeEvaluation(
  reason: string,
  evalSlicePath: string,
  supplementPath: string
): string {
  return [
    "# Agent Evaluation — evidence-insufficient",
    "",
    "## 任务与结果",
    "- 任务：基于 bounded evidence 评估该轨迹。",
    "- 交付结果：无法判断",
    "",
    "## 效率",
    "- 等级：无法判断",
    "- 主因：none",
    `- 证据：第二轮仍请求更多证据，原因：${reason || "未说明"}。`,
    "",
    "## 与静态结论对照",
    "- bounded evidence 不足，无法可靠确认或否定静态结论。",
    "",
    "## 改进建议",
    "1. 检查 slice 选择规则是否遗漏了决定性步骤。",
    "",
    "## artifact 索引",
    `- ${evalSlicePath}`,
    `- ${supplementPath}`,
  ].join("\n");
}
