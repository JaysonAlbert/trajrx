# Doctor — AgentRx-style IDE Agent Attribution Pipeline

**Runtime:** TypeScript / Node.js ≥20  
**Entry:** `npm run analyze -- <transcript.jsonl>` or `node dist/cli.js`

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
│ Stage 0  src/export/flatten.ts                                   │
│  JSONL → 平铺 Markdown (.flat.md) — 供 AI 直接阅读               │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│ Stage 1  src/ir/loader.ts + src/ir/cursorIr.ts                  │
│  Raw events → Trajectory IR (trajectory_id, steps, telemetry)    │
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
```

### 目录结构

```
doctor/
├── package.json
├── tsconfig.json
├── src/
│   ├── cli.ts              # CLI 入口
│   ├── pipeline.ts         # 编排 Stage 0–5
│   ├── types/index.ts      # 共享类型
│   ├── export/flatten.ts   # 平铺 Markdown
│   ├── ir/                 # loader, cursorIr, schema
│   ├── invariants/         # presets, checker
│   ├── judge/attributor.ts
│   └── analyst/reconcile.ts
├── dist/                   # tsc 编译输出
└── runs/                   # 分析产物（gitignore）
```

### 模块职责

| 包 | 职责 | LLM |
|----|------|-----|
| `src/export/` | Transcript 平铺 Markdown | 否 |
| `src/ir/` | JSONL → Trajectory IR | 否 |
| `src/invariants/` | 确定性约束检查 | 否 |
| `src/judge/` | violation 加权归因 | 否 |
| `src/analyst/` | 阶段启发式 + 对账 | 否 |

### 设计原则（AgentRx）

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
├── <session_id>.flat.md
├── trajectory_ir.json
├── checker_results/violations.json
├── judge_output/attribution.json
├── reports/<session_id>.md
└── reconcile/reconciliation.json
```

## Flat Markdown 格式

- `## User Turn N (#UN)` — 用户轮次
- `## Assistant Step N (#SN, after #UN)` — 与 IR step.index 对齐
- `### Tool:` / MCP 结构化块
- 末尾 `## Attribution Summary` — pipeline 自动追加

## 后续扩展

- [ ] Codex rollout-trace IR converter
- [ ] Dynamic invariants（LLM 逐步生成）
- [ ] Cursor hooks OTel 接入
- [ ] npm package / VS Code 扩展
