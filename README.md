<p align="center">
  <h1 align="center">pi-deep-research</h1>
  <p align="center">
    <b>可溯源、可验证、可恢复的 Deep Research Agent</b><br>
    基于 <a href="https://github.com/earendil-works/pi">pi</a> Agent 框架二次开发的扩展插件
  </p>
  <p align="center">
    <img alt="tests" src="https://img.shields.io/badge/tests-260%20passing-brightgreen?style=flat-square" />
    <img alt="typescript" src="https://img.shields.io/badge/TypeScript-strict%20%2B%20erasable-blue?style=flat-square" />
    <img alt="license" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" />
    <img alt="status" src="https://img.shields.io/badge/pipeline-end--to--end%20verified-success?style=flat-square" />
  </p>
</p>

---

用户提交一个开放式问题，Agent 自主理解目标、规划任务、联网搜集证据，产出**每一条结论都能点击溯源到原始网页原文**的调研报告。全流程内置三层失败兜底，任意环节异常均收敛降级而非崩溃。

```
/research 调研2026年AI Agent市场，比较OpenAI、Anthropic、Google的产品布局
        │
        ▼
  理解目标 ──→ 规划任务 ──→ 联网取证 ──→ 生成报告 ──→ 双向校验
  (6条判据)    (7个任务)     (19条证据)   (24条结论)   (0 悬空引用)
        │
        ▼
  status: completed  ·  report.md  ·  引用全部可点击溯源
```

> 以上为真实运行数据（run `20260825-145232-iis`，非演示脚本）。

---

## 为什么不是又一个 "Search → LLM → Report"

普通调研 Agent 的三个结构性缺陷，就是本项目的全部设计动机：

| 缺陷 | 后果 | 本项目的解法 |
|---|---|---|
| **引用可编造** | 报告看着有引用，实际支撑不住原句 | Evidence 先固化 → Claim 只能引用已落库 id → Report 只能由 Claim 组装。**引用的是数据主键，不是模型自由文本** |
| **结论不可追溯** | 无法回答"这句话从哪来的" | 每条证据的原文摘录（quote）必须能在源网页中**三级定位**（exact→归一化→fuzzy），定位失败直接拒收 |
| **失败即崩溃** | 一次超时，全盘作废 | 三层失败策略路由，所有重试循环由代码硬计数（不依赖模型判断），**任意故障链在有限步内收敛到优雅降级** |

实测验证：真实运行中模型曾自造 `[^T2e1]` 格式的证据 id——L1 校验当场抓获，26 条结论中 22 条引用无效。**报告看着漂亮，校验一眼看穿。** 这就是 Evidence-first 和玩具 Demo 的区别。

---

## 核心设计

### 1. 证据链外键约束 —— 根除引用幻觉

```
Criterion (SC3)
  ↓ Task.criterionIds      ← Planner 填，经代码覆盖度硬校验
Task (T3)
  ↓ Evidence.taskId        ← 工具落库时写入，模型无法伪造
Evidence (e7)
  ↓ Claim.evidenceIds      ← L1 校验存在性（引用不存在的 id 判 dangling）
Claim (c5)
```

覆盖度用**血缘反推**，不信模型自报标签。测试里有一个专门的反绕过用例：Reporter 给 claim 打满全部 SC 标签，覆盖度照样判不通过。

### 2. quote 三级定位 + 数字保护 —— 防"改一个数字"

- **归一化位置映射**（借鉴编译器 source map）：全角/半角、空白折叠改变长度后，仍能映射回原文真实区间
- **短引用禁 fuzzy**：<30 字符没有模糊匹配的余地
- **数字保护前置过滤**：`"营收增长 30%"` vs `"80%"` 相似度 0.94 本可通过 fuzzy，但数字逐一比对不符即拒收——研究报告的核心价值在数据，数字错了整条证据就是有害的

### 3. 收敛式失败兜底 —— 每条循环都有硬上限

| 潜在循环 | 上限 | 收敛终点 |
|---|---|---|
| Task 内 ReAct 无限轮 | 8 轮 | Task 结束 |
| Query Rewrite 反复失败 | 策略池 4 条，≤3 次 | `unresolved`，禁止再搜 |
| quote 无法定位反复重摘 | 每条 2 次 | 丢弃该条 |
| task_exception | 重跑 1 次 | `failed` |
| 证据不足补充子任务 | 1 次 | minEvidence 降 1 → 降级 |
| Re-plan 循环 | 上限 1 次 | 带现有证据结报 |
| Budget 三维（tokens/cost/time） | 任一越限即熔断 | 降级结报 |
| LLM 调用挂起 | 90s/120s 超时 | 走降级路径 |

失败任务降级为报告中的「研究空白」章节，而非整体崩溃。**诚实报告"没查到"，比编造一段填上去有价值。**

### 4. 双向安全建模

**出向 SSRF 防护**（72 个测试用例）：
DNS 解析后校验 IP · 逐跳重定向校验 · 私网段与隧道协议（NAT64/Teredo/6to4）封堵 · 整数/十六进制 IPv4 绕过拦截 · DNS rebinding pinned lookup 直连

**入向提示注入防护**：
网页正文是不可信输入。边界包裹 `<untrusted-content>` + 系统锚定声明 + **能力约束**（Executor 无 bash/write/edit 权限）——即使注入完全成功，最坏结果是被记录一条带 URL 的假证据，无法升级为代码执行。

### 5. 校验器自证 —— 当校验器可能失效时

L2 语义校验全部判 `supported` 时（橡皮图章失效模式），报告主动标注：

```
- ⚠ 语义校验未产生任何异议：全部判 supported，校验结果可信度存疑（可能存在同源偏差）
```

**校验器可能失效时，把这个事实呈现给用户，而不是隐藏它。**

---

## 可观测性

每次研究的完整执行轨迹可追溯（`/research:status`）：

```
Research Run 20260825-145232-iis  (completed)
Query: 调研2026年AI Agent市场，比较OpenAI、Anthropic、Google的产品布局

[1] Comprehend            6 criteria
[2] Plan                  7 tasks
[3] Research
    T1 市场规模            ✓  2 evidence
    T2 OpenAI 布局         ✓  2 evidence
    T3 Anthropic 布局      ✓  3 evidence
    T4 Google 布局         ✓  2 evidence
    T5 技术路线差异化       ✓  6 evidence
    T6 定价与功能对比       ✓  2 evidence
    T7 竞争优劣势          ✓  2 evidence
[4] Report                24 claims
[5] Verify  L1 ✓  0 dangling, coverage 6/6
            L2 ✓  20 supported / 1 conflicting / 3 uncertain

Total  7m42s   ↑187k   $0.31   no failures
Report: .codebuddy/research/20260825-145232-iis/report.md
```

产物目录：

```
.codebuddy/research/<runId>/
├── run.json        权威状态快照（brief/plan/sources/evidence/claims/verification）
├── events.jsonl    执行事件流（append-only，审计与断点恢复依据）
├── report.md       最终报告（含研究空白与校验结果章节）
├── report.html     自包含溯源报告（点击引用 → quote 在原文中的上下文高亮）
├── sources/        抓取的网页原文（quote 定位校验所需）
└── cache/          搜索/抓取缓存（崩溃恢复后不重复烧钱）
```

支持 `/research:resume <runId>` 断点续跑——进程被 kill 后从最后一个 Task 检查点恢复，缓存命中不重复计费。

**HTML 溯源报告**：每个 run 自动导出单文件 `report.html`（inline CSS/JS，双击即开，无需 server）。正文中的 `[^e3]` 引用是可点按钮，点击展开证据面板：quote 在原始网页正文中的上下文高亮（`locator` 区间切片）、来源链接、定位级别（exact/normalized/fuzzy 三色标记，fuzzy 附实际相似度）。旧 run 可用 `/research:export [runId]` 补导。安全与主流程同级：一切动态文本转义、链接协议白名单、`default-src 'none'` CSP——页面不发任何网络请求。

---

## 快速开始

**前提**：Node.js ≥ 22.19（内置 TS 类型剥离，直跑 TS 源码，无需构建）

```bash
git clone https://github.com/collaspor/pi_search.git
cd pi_search
npm install --ignore-scripts
```

在仓库根目录创建 `.env`（已 gitignore，不会提交），写入两个 API key：

```bash
TAVILY_API_KEY=tvly-...     # 搜索（tavily.com 注册即得，免费 1000 credits/月）
DEEPSEEK_API_KEY=sk-...     # LLM（也可用 ANTHROPIC_API_KEY / OPENAI_API_KEY，配合 --model 换模型）
```

启动（扩展激活时自动加载 `.env`，无需手动 export）：

```bash
npx pi -e . --model deepseek/deepseek-v4-flash
```

TUI 中输入：

```
/research 调研2026年AI Agent市场，比较OpenAI、Anthropic、Google的产品布局
```

先弹 Brief 确认（Enter 开始 / Esc 取消）→ 实时进度 → 报告落盘 `.codebuddy/research/<runId>/report.md`。

**命令**：

| 命令 | 说明 |
|---|---|
| `/research <query>` | 启动研究 |
| `/research:status [runId]` | 查看执行 Trace 树 |
| `/research:list` | 列出全部 run |
| `/research:resume <runId>` | 断点续跑 |
| `/research:export [runId]` | 导出/补导 HTML 溯源报告 |

---

## 测试

```bash
npm test
```

**260 个测试，全部离线可跑**（faux provider + 注入桩 + mock DNS，零真实网络/LLM 依赖）：

- SSRF 防护（72 例：302 跳私网、IPv4-mapped、DNS rebinding、整数 IPv4 绕过……）
- 提示注入防护（12 例：真实注入载荷、边界逃逸、Markdown 伪造）
- quote 三级定位（22 例：全角半角、数字篡改、短引用禁 fuzzy、阈值边界、大正文性能回归）
- 血缘覆盖度（含"Reporter 打满 SC 标签不得通过"的反绕过用例）
- 失败策略（24 例：策略池顺序、硬计数上限、Budget 三维熔断、Re-plan 判定）
- 超时收敛（LLM 挂起→降级结局，不冻结）
- Executor 端到端（faux 驱动完整 Agent Loop：搜索→抓取→篡改 quote 被拒→改摘录→成功）

---

## 技术决策摘要

| 决策 | 理由 |
|---|---|
| pi Extension 而非改源码 | 零侵入接入，上游升级无冲突；`AgentContext.tools` per-run 隔离各角色工具集 |
| tool call 承载结构化输出 | TypeBox schema 约束模型输出，根上杜绝 markdown 围栏/尾逗号解析失败 |
| 单次全量证据输入 Reporter | 20~40 条证据仅 8k~25k tokens，比 agent loop 增量检索更可靠（检索未召回=该写的没写进报告） |
| 脚注定义行代码生成 | 不信 LLM 自写的来源行（实测发现过伪造），剥离后按正文引用确定性重建 |
| 快照 + 事件溯源双写 | run.json 原子快照供查询，events.jsonl append-only 供审计与断点恢复 |
| 静态前缀 + 动态后缀 prompt | 角色协议固定放头部，吃满 provider 前缀缓存（成本 -60% 级） |

---

## 已知边界（诚实记录）

- **预算是软上限**：每 Task 结束才检查熔断，实际消耗可能略超设定值（设计取舍，逐 token 拦截成本过高）
- **校验判据由 LLM 生成**：successCriteria 若跑偏，会形成"用错误标准验证错误报告"。缓解：Brief 人工确认默认开启（全流程唯一人工纠偏窗口）
- **L2 同源偏差**：Reporter 与 Verifier 若用同一模型，共享先验与幻觉倾向。缓解：`--research-verifier-model` 可指定不同模型
- **fuzzy 阈值 0.90 已经真实数据标定**：56 条证据（fuzzy 12 条）命中 score 全部 ≥0.906，阈值保留；实现已改为锚点预筛（修复大正文 O(N×M²) CPU 爆炸，A9 实测卡顿 7 分 46 秒 → 毫秒级）

---

## License

MIT
