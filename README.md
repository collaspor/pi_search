# pi-deep-research

> 一个可溯源、可验证、可恢复的 Deep Research Agent —— 基于开源 Agent 框架 [pi](https://github.com/earendil-works/pi) 二次开发的扩展插件。

用户提交开放式问题后，Agent 自主理解目标、规划任务、联网搜集证据，产出**每条结论都能追溯到原始网页原文**的调研报告；全流程内置失败兜底，任意环节异常均收敛降级而非崩溃。

## 为什么不是又一个 "Search → LLM → Report"

普通调研 Agent 的三个结构性缺陷，正是本项目要解决的核心问题：

| 缺陷 | 本项目的解法 |
|---|---|
| **引用可编造**（事后合理化：先写报告再找引用） | **Evidence-first 证据链**：Evidence 先固化（不可变）→ Claim 只能引用已落库 id → Report 只能由 Claim 组装。引用的是数据库主键而非模型生成的文本，结构上无法编造 |
| **结论不可追溯** | **quote 三级定位校验**：模型摘录的原文必须能在源网页中定位（exact→归一化→fuzzy），定位失败直接拒收；数字被篡改即拒收 |
| **失败即崩溃** | **收敛式失败兜底**：三层失败策略路由，所有重试循环由代码硬计数控制（不依赖模型判断），任意故障链在有限步内收敛到优雅降级 |

## 架构

```
/research <query>
   │
   ├─ [1] Comprehender   理解目标 → ResearchBrief（含 3~7 条 successCriteria）
   │        ↓ 人工确认（默认开启，唯一纠偏窗口）
   ├─ [2] Planner        规划任务 → ResearchPlan（4~8 个 Task，覆盖度硬校验）
   │
   ├─ [3] Executor ×N    每 Task 独立 pi Agent Loop（独立上下文）
   │        │            工具：web_search / web_fetch / evidence_record
   │        └─ 串行/拓扑分层并发 → Evidence（quote 三级定位校验）
   │
   ├─ [4] Reporter       证据 → Claims + Markdown（无 search 工具，防边写边搜）
   │
   └─ [5] Verifier L1    六条结构校验（纯代码 0 token）→ 报告
```

**六大核心能力**：理解目标 / 规划执行 / 工具接入 / Evidence-first / 报告校验 / 失败兜底

## 关键设计

### 1. 证据链外键约束（根除引用幻觉）

```
Criterion (SC3)
  ↓ Task.criterionIds      ← Planner 填，经代码覆盖度校验
Task (T3)
  ↓ Evidence.taskId        ← 工具落库时写入，模型无法伪造
Evidence (e7)
  ↓ Claim.evidenceIds      ← L1 校验存在性（引用不存在的 id 判 dangling）
Claim (c5)
```

每一环都不由 Reporter 自由决定——覆盖度用血缘反推，不信模型自报标签。

### 2. quote 三级定位 + 数字保护

- **归一化位置映射**（借鉴编译器 source map）：全角/半角、空白折叠改变长度后仍能映射回原文真实区间
- **短引用禁 fuzzy**（<30 字符没有模糊匹配余地）
- **数字保护前置过滤**："营收增长 30%" vs "80%" 相似度 0.94 本可通过 fuzzy，但数字逐一比对不符即拒收

### 3. 失败收敛（每条循环都有硬上限）

| 潜在循环 | 上限 | 终点 |
|---|---|---|
| Task 内 ReAct 无限轮 | `MAX_TURNS_PER_TASK = 8` | Task 结束 |
| Query Rewrite 反复失败 | 策略池 4 条，≤3 次 | `unresolved` |
| quote 无法定位反复重摘 | 每条 2 次 | 丢弃该条 |
| Re-plan 循环 | 上限 1 次 | 带现有证据结报 |
| L1 回灌修正循环 | 上限 1 次，之后确定性剔除 | `partial` / `failed` |

失败任务降级为报告中的"研究空白"章节，而非整体崩溃。

### 4. 双向安全建模

- **出向 SSRF 防护**：DNS 解析后校验 IP、逐跳重定向校验、私网段与隧道协议（NAT64/Teredo/6to4）封堵、DNS rebinding pinned lookup 直连
- **入向提示注入防护**：不可信内容边界包裹 + 执行器能力约束（Executor 无 bash/write/edit 权限），注入影响面限制在数据层，无法升级为代码执行

### 5. 校验器自证

当 L2 语义校验全部判 `supported` 时（橡皮图章失效模式），报告主动标注"校验结果可信度存疑"——校验器可能失效时，把这个事实呈现给用户而非隐藏。

## 快速开始

### 前提

```bash
# 需要两个 API key（环境变量）
export TAVILY_API_KEY="tvly-..."       # 搜索（tavily.com 注册即得，免费 1000 credits/月）
export DEEPSEEK_API_KEY="sk-..."       # LLM（或 ANTHROPIC_API_KEY / OPENAI_API_KEY 等任一 pi 支持的 provider）
```

### 运行

```bash
# 在 pi monorepo 根目录
node packages/coding-agent/dist/cli.js -e packages/deep-research --model deepseek/deepseek-v4-flash
```

进入 TUI 后输入：

```
/research 调研2026年AI Agent市场，比较OpenAI、Anthropic、Google的产品布局
```

### 产物

```
.codebuddy/research/<runId>/
├── run.json        权威状态快照（brief/plan/sources/evidence/claims/verification）
├── events.jsonl    执行事件流（append-only，审计与断点恢复依据）
├── report.md       最终报告（含研究空白与校验结果章节）
├── sources/        抓取的网页原文（quote 定位校验所需）
└── cache/          搜索/抓取缓存（崩溃恢复后不重复烧钱）
```

## 测试

```bash
# 200 个自动化测试，全部离线可跑（faux provider + 注入桩 + mock DNS，零真实网络/LLM）
cd packages/deep-research
node ../../node_modules/vitest/dist/cli.js --run test/
```

覆盖：SSRF 防护（72 例）、提示注入防护（12 例）、quote 定位（20 例）、血缘覆盖度（含"Reporter 打满 SC 标签不得通过"的反绕过用例）、checkpoint/replay、工具链、Executor 端到端、报告渲染与 L1 校验。

## 开发进度

| 里程碑 | 状态 | 内容 |
|---|---|---|
| M1 安全与骨架 | ✅ | SSRF/注入防护、HTTP 客户端、搜索抽象 |
| M2 校验内核 | ✅ | quote 定位、血缘覆盖度、checkpoint/replay |
| M3 理解与规划 | ✅ | Comprehender/Planner（tool call 输出，faux 测试） |
| M4 工具与执行 | ✅ | 三个工具 + Executor（pi Agent Loop） |
| M5 报告与校验 | ✅ | Reporter、L1 六条校验、研究空白、run 闭环 |
| M6 失败兜底 | 🚧 | 三层策略路由、Budget 熔断、Query Rewrite |
| M7 语义校验+续跑 | ⬜ | L2 Verifier、resume、Trace 树渲染 |
| M8 真实联调 | ⬜ | A1~A10 验收全绿 |

**已端到端验证**：7 任务、19 证据、24 结论，L1 全通过，终态 `completed`。

## 技术栈

TypeScript / Node.js 22+ · pi Agent 框架（Agent Loop / Tool 系统 / Extension API）· TypeBox（schema）· Tavily（搜索）· undici（HTTP）· @mozilla/readability（正文提取）· Vitest（测试）

## License

MIT
