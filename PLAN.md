# TrajRx — IDE Agent Trajectory Attribution Pipeline

**Runtime:** TypeScript / Node.js ≥20  
**Entry:** `npm run analyze -- <transcript.jsonl>` or `node dist/cli.js`

## 技术架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        Input Sources                             │
│  Cursor ~/.cursor/projects/*/agent-transcripts/*.jsonl          │
│  Codex ~/.codex/sessions/**/rollout-*.jsonl                      │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ Stage 0  src/export/flatten.ts                                   │
│  JSONL → 平铺 Markdown (.flat.md) — 供 AI 直接阅读               │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ Stage 1  src/ir/loader.ts + cursorIr / codexIr                  │
│  Raw events → Trajectory IR (steps, telemetry, session metrics)  │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ Stage 2  src/invariants/presets.ts + checker.ts                 │
│  11 条 preset invariant → auditable violation log               │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ Stage 3  src/judge/attributor.ts                                │
│  规则聚合 → primary_cause / composite / critical_step           │
└────────────────────────────┬────────────────────────────────────┘
                             │
              ┌──────────────┴──────────────┐
              ▼                             ▼
┌──────────────────────────┐   ┌──────────────────────────┐
│ Stage 4  export/ reports  │   │ Stage 5  analyst/         │
│  report.md + .flat.md     │   │  reconcile static/manual  │
└──────────────────────────┘   └──────────────────────────┘
                             │
                             ▼ (optional --agent-eval)
┌─────────────────────────────────────────────────────────────────┐
│ Stage 6  src/eval/runAgentEval.ts + src/agentCli/               │
│  bounded eval_slice.md → agent CLI → optional one supplement    │
│  → agent-evaluation.md                                          │
│  profiles: cursor-agent | claude | codex                        │
└─────────────────────────────────────────────────────────────────┘
```

### 目录结构

```
trajrx/
├── package.json
├── tsconfig.json
├── docs/                   # VitePress 文档站
├── src/
│   ├── cli.ts              # CLI 入口
│   ├── pipeline.ts         # 编排 Stage 0–6
│   ├── config.ts           # 环境变量与路径
│   ├── types/              # 共享类型
│   ├── export/             # 平铺 Markdown、analysis-report
│   ├── ir/                 # loader, cursorIr, codexIr, sessionMetrics
│   ├── invariants/         # presets, checker
│   ├── enrich/             # toolMetrics (Cursor), codexToolMetrics
│   ├── judge/attributor.ts
│   ├── analyst/reconcile.ts
│   ├── session/search.ts   # --source --title 会话查找
│   ├── ui/                 # pipeline TUI、run summary
│   ├── agentCli/           # cursor | claude | codex CLI profiles
│   └── eval/               # LLM agent-evaluation stage
├── dist/                   # tsc 编译输出
└── runs/                   # 分析产物（gitignore）
```

### 模块职责

| 包 | 职责 | LLM |
|----|------|-----|
| `src/export/` | Transcript 平铺 Markdown、analysis-report | 否 |
| `src/ir/` | JSONL → Trajectory IR、会话墙时指标 | 否 |
| `src/enrich/` | 工具耗时、grep、Codex background exec | 否 |
| `src/invariants/` | 确定性约束检查 | 否 |
| `src/judge/` | violation 加权归因 | 否 |
| `src/analyst/` | 阶段启发式 + 对账 | 否 |
| `src/session/` | 按标题查找 Codex/Cursor 会话 | 否 |
| `src/ui/` | 终端进度、run.log、run-summary | 否 |
| `src/agentCli/` | 可插拔 agent CLI 调用（cursor/claude/codex） | 是（外部 CLI） |
| `src/eval/` | LLM 评估 prompt + 产物写入 | 是（外部 CLI） |

### 设计原则（TrajRx）

1. **Checker 先行，Judge 殿后** — 证据可审计
2. **IR 统一异构源** — 同一 schema 走同一套 invariant
3. **Flat Markdown 面向 AI** — `#SN` 与 checker `step_index` 对齐

---

## CLI

```bash
npm install
npm run build

# 完整 pipeline
npm run analyze -- transcript.jsonl --run-name my-run

# 按 Codex 会话标题分析
trajrx --source codex --title "修复 ZYTGXT-131287" --run-name ZYTGXT-131287

# 列出匹配的 Cursor 会话
trajrx --source cursor --title "ZYTGXT-117563" --list-sessions

# 开发模式（tsx，免 build）
npm run dev -- transcript.jsonl

# 仅导出 flat markdown
npm run dev -- transcript.jsonl --flatten-only -o out.flat.md

# 批量
npm run dev -- ~/.cursor/projects --batch
```

## Pipeline 阶段

```
Raw logs → Flat Markdown → Trajectory IR → Checker → Judge → Report → Reconcile
```

## 输出目录 (`runs/<name>/`)

```
runs/<name>/
├── run.log
├── run-summary.md / run-summary.json
├── <session_id>.flat.md
├── trajectory_ir.json          # metadata.session_wall_ms 等（Codex）
├── analysis-report.md          # §2 会话指标：含/不含用户等待
├── checker_results/violations.json
├── judge_output/attribution.json
├── reports/<session_id>.md
├── tool_efficiency.json
└── reconcile/reconciliation.json
```

## 会话墙时指标

| 指标 | 含义 |
|------|------|
| 会话墙时（含用户等待） | 首条 → 末条 transcript 事件跨度 |
| 会话活跃墙时（扣除用户等待） | 上述跨度减去各轮用户输入之间的空档 |
| 工具总墙时 | 各工具 `duration_ms` 之和（≠ 会话墙时） |

Codex 在 IR 阶段通过 `buildCodexSessionWallMetrics()` 写入；Cursor 通过 `buildCursorSessionWallMetrics()` 使用文件 mtime（gross）与 terminal 时间戳间隙（idle，可选）。详见 `docs/reference/metrics.md`。

异构源 enrich/flatten/IR 由 `src/ir/adapters/`（`TranscriptAdapter`）统一编排，`stepTelemetry.ts` 供两 IR builder 共用。

## Flat Markdown 格式

- `## User Turn N (#UN)` — 用户轮次
- `## Assistant Step N (#SN, after #UN)` — 与 IR step.index 对齐
- `### Tool:` / MCP 结构化块
- 末尾 `## Attribution Summary` — pipeline 自动追加

## 后续扩展

- [x] Codex rollout-trace IR converter (`src/ir/codexParser.ts`, `codexIr.ts`, `codexToolMetrics.ts`)
- [x] Agent CLI 评估路径（`--agent-eval` / `--agent-eval-only`）
- [x] 按标题查找会话（`--source codex|cursor --title`）
- [x] 终端 UI + run summary（listr2 / boxen）
- [x] 会话墙时 gross/net（Codex 事件戳；Cursor 文件 mtime + terminal 间隙）
- [x] TranscriptAdapter 抽象（`src/ir/adapters/`）
- [ ] Dynamic invariants（LLM 逐步生成）
- [ ] Cursor hooks OTel 接入
- [ ] npm package / VS Code 扩展

## Agent Evaluation 两级证据机制

`--agent-eval` 不再要求 Agent 自己遍历完整 flat transcript。TrajRx 先用固定规则生成
`eval_slice.md`：

- 保留任务、全部用户轮次和最终 Assistant Step。
- 选择 `critical_step`、high-severity violation、最大输出和最慢调用对应的步骤。
- 每段和整份 slice 都有显式字符上限；截断和遗漏写入 coverage manifest。
- 静态指标只嵌入 compact summary，原始 artifact 路径保留在索引中。
- compact summary 明确区分 `command_breakdown` 的 observed calls 与启发式 feature
  counters；两者冲突时 Agent 必须使用 observed breakdown，并披露遥测限制。

Agent 第一轮只能基于 slice 给出最终评估，或返回
`{"status":"needs_more_evidence","step_ids":[...],"reason":"..."}`。TrajRx 最多接受一次补读，
把有效 step 原文写入 `eval_slice_supplement.md` 后执行第二轮。第二轮不能继续申请补读；
证据仍不足时必须在最终 Markdown 中把交付结果写为“无法判断”。
