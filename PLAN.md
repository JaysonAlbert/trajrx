# Doctor — AgentRx-style IDE Agent Attribution Pipeline

## 技术架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        Input Sources                             │
│  Cursor ~/.cursor/projects/*/agent-transcripts/*.jsonl          │
│  (future: Codex rollout-trace, hooks OTel)                       │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ Stage 0  export/flatten.py                                       │
│  JSONL → 平铺 Markdown (.flat.md) — 供 AI 直接阅读               │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ Stage 1  ir/loader.py + ir/cursor_ir.py                         │
│  Raw events → Trajectory IR (trajectory_id, steps, telemetry)    │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ Stage 2  invariants/presets.py + invariants/checker.py          │
│  11 条 preset invariant → auditable violation log               │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ Stage 3  judge/attributor.py                                    │
│  规则聚合 → primary_cause / composite / critical_step           │
└────────────────────────────┬────────────────────────────────────┘
                             │
              ┌──────────────┴──────────────┐
              ▼                             ▼
┌──────────────────────────┐   ┌──────────────────────────┐
│ Stage 4  reports/         │   │ Stage 5  analyst/         │
│  attribution report .md   │   │  manual heuristic +       │
│  + append to .flat.md     │   │  reconcile static vs manual│
└──────────────────────────┘   └──────────────────────────┘
```

### 模块职责

| 包 | 职责 | 是否用 LLM |
|----|------|-----------|
| `doctor/export/` | Transcript 平铺 Markdown | 否 |
| `doctor/ir/` | 异构 log 归一化为 Trajectory IR | 否 |
| `doctor/invariants/` | 确定性约束检查 | 否 |
| `doctor/judge/` |  violation 加权归因 | 否 |
| `doctor/reports/` | 人类可读报告 | 否 |
| `doctor/analyst/` | 阶段分析 + 静态/人工对账 | 否 |

### 设计原则（来自 AgentRx）

1. **Checker 先行，Judge 殿后** — 证据必须可审计
2. **IR 统一异构源** — 同一 schema 走同一套 invariant
3. **Flat Markdown 面向 AI** — 归因输入与人类 review 共用一份可读 transcript

### 输出目录 (`runs/<name>/`)

```
runs/<name>/
├── <session_id>.flat.md      # 平铺 transcript（含末尾 attribution 摘要）
├── trajectory_ir.json        # 结构化 IR
├── checker_results/
│   ├── violations.json
│   └── static_invariants.json
├── judge_output/
│   └── attribution.json
├── reports/
│   ├── <session_id>.md
│   └── metrics.json
└── reconcile/
    ├── reconciliation.json
    └── <session_id>_reconcile.md
```

---

## 目标

对 Cursor / Codex 等 IDE agent 的 session transcript 做**工程化低效归因**：
上下文、工具、MCP、Skill 四维分类，产出可审计 violation log，而非 LLM 自由总结。

## 方法论（复刻 AgentRx）

```
Raw logs → Flat Markdown → Trajectory IR → Static Invariants → Checker → Judge → Reports → Reconcile
```

| Stage | 模块 | 输出 | LLM |
|-------|------|------|-----|
| 0 Flatten | `doctor/export/` | `<id>.flat.md` | 否 |
| 1 IR | `doctor/ir/` | `trajectory_ir.json` | 否 |
| 2 Static | `doctor/invariants/presets.py` | `static_invariants.json` | 否 |
| 3 Check | `doctor/invariants/checker.py` | `checker_results/violations.json` | 否 |
| 4 Judge | `doctor/judge/attributor.py` | `judge_output/attribution.json` | 否（规则聚合） |
| 5 Report | `doctor/reports/aggregator.py` | `report.md` + append `.flat.md` | 否 |
| 6 Reconcile | `doctor/analyst/` | `reconciliation.json` | 否 |

> MVP 跳过 Dynamic Invariants（LLM 逐步生成约束），先用 preset 确定性规则覆盖 80% 场景。

## Trajectory IR Schema

```json
{
  "trajectory_id": "c129aee9-...",
  "source": "cursor",
  "instruction": "用户首条 query",
  "metadata": { "project": "...", "line_count": 344 },
  "steps": [
    {
      "index": 1,
      "telemetry": {
        "tool_count": 5,
        "mcp_count": 2,
        "shell_count": 1,
        "read_count": 2,
        "grep_count": 0,
        "assistant_chars": 120,
        "user_turn": 1
      },
      "substeps": [
        { "sub_index": 1, "role": "assistant", "content": "..." },
        { "sub_index": 2, "role": "tool:Shell", "content": "harness env status" },
        { "sub_index": 3, "role": "mcp:user-logyi", "content": "..." }
      ]
    }
  ]
}
```

## Cursor JSONL 映射规则

- 每行 JSON：`role` = `user` | `assistant`
- 每个 **assistant 行** = 1 个 `step`
- `message.content[]` 中：
  - `type=text` → substep role `assistant`
  - `type=tool_use` → substep role `tool:<name>` 或 `mcp:<server>`（CallMcpTool 解析 server）
- 每个 **user 行** 递增 `user_turn` 计数

## Preset Invariants（效率归因）

| ID | Category | 规则 |
|----|----------|------|
| INV-CTX-001 | context | 单 step 工具调用数 > 8 |
| INV-CTX-002 | context | 累计 Read 文件数 > 40 |
| INV-CTX-003 | context | 连续 3 step 无 user 新输入（agent 自旋） |
| INV-TOOL-001 | tool | 同一 Grep pattern 重复 ≥ 3 次 |
| INV-TOOL-002 | tool | 同一 Shell 命令重复 ≥ 2 次 |
| INV-TOOL-003 | tool | Shell 失败（exit≠0 关键词）后未换策略 |
| INV-MCP-001 | mcp | MCP 调用占比 > 30% 且 session > 50 tools |
| INV-MCP-002 | mcp | 同一 MCP server 连续失败 ≥ 3 |
| INV-SKILL-001 | skill | 读了 skill 但后续仍大量重复探索（Read+Grep > 20 且无 Write） |
| INV-SKILL-002 | skill | 任务涉及 harness 但未读 harness skill |

## Judge 聚合逻辑

1. 按 category 统计 violation 的 weighted severity
2. `primary_cause` = 最高分 category
3. `critical_step` = 该 category 最早 high/critical violation 的 step
4. 生成 `recommended_actions` 模板

## CLI

```bash
# 完整 pipeline（含 flat markdown）
python run.py <transcript.jsonl> [--run-name NAME]

# 仅导出平铺 markdown
python run.py <transcript.jsonl> --flatten-only [-o out.md]

# 批量
python run.py <dir> --batch

# 跳过归因
python run.py <transcript.jsonl> --skip-judge
```

## Flat Markdown 格式

每个 session 输出一份线性 Markdown：

- `# Cursor Session Transcript` + metadata 表
- `## Task` — 首条用户 query
- `## User Turn N (#UN)` — 用户消息
- `## Assistant Step N (#SN, after #UN)` — assistant 一步
  - 正文文本
  - `### Tool: Read/Grep/Shell/...` — 结构化工具块
  - `### Tool: CallMcpTool` — MCP server + args JSON
- `## Session Stats` — 统计
- （pipeline 完成后）`## Attribution Summary` — 归因摘要

Step 编号 `#SN` 与 IR `step.index`、checker `step_index` 对齐，方便 AI 交叉引用。

## 目录结构

```
doctor/
├── PLAN.md
├── pyproject.toml
├── run.py
├── doctor/
│   ├── export/
│   │   └── flatten.py          # JSONL → flat markdown
│   ├── ir/
│   │   ├── loader.py
│   │   ├── cursor_ir.py
│   │   └── schema.py
│   ├── invariants/
│   │   ├── presets.py
│   │   └── checker.py
│   ├── judge/
│   │   └── attributor.py
│   └── reports/
│       └── aggregator.py
└── runs/
```

## 后续扩展

- [ ] Dynamic invariants（LLM 逐步生成，oneshot 模式）
- [ ] Codex rollout-trace IR converter
- [ ] Cursor hooks OTel 接入，补 latency/token
- [ ] Langfuse/Laminar 写入 attribution tags
