# Doctor — AgentRx-style IDE Agent Attribution Pipeline

## 目标

对 Cursor / Codex 等 IDE agent 的 session transcript 做**工程化低效归因**：
上下文、工具、MCP、Skill 四维分类，产出可审计 violation log，而非 LLM 自由总结。

## 方法论（复刻 AgentRx）

```
Raw logs → Trajectory IR → Static Invariants → Checker → Judge → Reports
```

| Stage | 模块 | 输出 | LLM |
|-------|------|------|-----|
| 1 IR | `doctor/ir/` | `trajectory_ir.json` | 否 |
| 2 Static | `doctor/invariants/presets.py` | `static_invariants.json` | 否 |
| 3 Check | `doctor/invariants/checker.py` | `checker_results/violations.json` | 否 |
| 4 Judge | `doctor/judge/attributor.py` | `judge_output/attribution.json` | 否（规则聚合） |
| 5 Report | `doctor/reports/aggregator.py` | `report.md` + `metrics.json` | 否 |

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
python run.py <transcript.jsonl> [--run-name NAME] [--batch DIR]
python run.py <transcript.jsonl> --stage ir|check|judge|report
python run.py <transcript.jsonl> --skip-judge
```

## 目录结构

```
doctor/
├── PLAN.md
├── pyproject.toml
├── run.py
├── doctor/
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
