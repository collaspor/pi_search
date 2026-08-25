/**
 * Deep Research Agent — 全部数据模型（PRD V1.1 §4 的代码化）
 *
 * 仅使用 erasable TypeScript 语法（无 enum / namespace / 参数属性）。
 */

// ============================================================================
// Run 生命周期
// ============================================================================

export type RunStatus =
	| "comprehending"
	| "planning"
	| "researching"
	| "reporting"
	| "verifying"
	| "completed" // 全流程成功且 L1 校验通过
	| "partial" // 出了含证据的报告，但存在 unresolved Task / 预算熔断 / 校验降级
	| "failed" // 未能产出含证据的报告；仍会落盘 report.md 存根说明原因
	| "cancelled";

export interface ResearchRun {
	id: string; // 形如 "20260825-143022-a3f"
	query: string;
	status: RunStatus;
	createdAt: number;
	updatedAt: number;
	schemaVersion: 1;

	brief?: ResearchBrief;
	plan?: ResearchPlan;
	sources: Source[];
	evidence: Evidence[]; // append-only，一旦写入永不修改
	claims: Claim[];
	report?: string;
	verification?: VerificationReport;

	budget: Budget;
	recoveries: RecoveryEvent[];
	lastSeq: number; // 已并入本快照的最大事件序号，重放对齐用（§4.0.1）
}

// ============================================================================
// 能力 1 — 理解目标
// ============================================================================

export interface Criterion {
	id: string; // "SC1"
	text: string;
}

export interface ResearchBrief {
	goal: string;
	scope: { included: string[]; excluded: string[] };
	entities: string[];
	timeRange?: { from?: string; to?: string };
	successCriteria: Criterion[]; // 3~7 条，校验判据来源
	assumptions: string[]; // 问题模糊处的显式假设
	outline: string[]; // 报告章节骨架
}

// ============================================================================
// 能力 2 — 规划与执行
// ============================================================================

export type TaskStatus = "pending" | "running" | "success" | "failed" | "unresolved";

export interface Task {
	id: string; // "T1"
	title: string;
	query: string; // 初始搜索查询
	rationale: string; // 为什么要做这个 Task
	criterionIds: string[]; // 非空，绑定 brief.successCriteria
	dependsOn: string[]; // 拓扑分层用
	status: TaskStatus;
	attempts: number;
	evidenceCount: number;
	minEvidence: number; // 默认 2
	startedAt?: number;
	finishedAt?: number;
	lastError?: string;
}

export interface ResearchPlan {
	tasks: Task[];
	replanCount: number; // 最多 1
}

// ============================================================================
// 能力 4 — Evidence-first
// ============================================================================

export type SourceTier = 1 | 2 | 3 | 4; // 1官方 2主流媒体 3行业 4其他

export type FetchStrategy = "readability" | "plaintext" | "raw_content" | "snippet";

export interface Source {
	id: string; // "s3"
	url: string;
	canonicalUrl: string; // 去 utm_* / fragment / 尾斜杠，用于去重
	title: string;
	domain: string;
	publishedAt?: string; // ISO8601
	retrievedAt: number;
	tier: SourceTier;
	fetchStrategy: FetchStrategy;
	contentHash: string; // sha256(正文)
	charCount: number;
	bodyRef: string; // 正文落盘相对路径 sources/<id>.txt
}

export type QuoteMatchLevel = "exact" | "normalized" | "fuzzy";

export type EvidenceStance = "support" | "refute" | "neutral";

export interface Evidence {
	id: string; // "e12"
	taskId: string;
	sourceId: string;
	quote: string; // 原文摘录，禁止改写
	summary: string; // LLM 归纳，与 quote 分列存储
	locator: { start: number; end: number }; // 正文字符区间
	stance: EvidenceStance;
	quoteMatch: QuoteMatchLevel; // 定位命中级别
	matchScore?: number; // fuzzy 时记录实际相似度
	createdAt: number;
}

export interface Claim {
	id: string; // "c5"
	text: string;
	evidenceIds: string[]; // 非空，L1 校验存在性
	criterionIds: string[]; // 仅展示与分组用，不作为覆盖度校验依据
	section: string; // 对应 brief.outline 章节
}

// ============================================================================
// 能力 5 — 校验
// ============================================================================

export interface CoverageEntry {
	criterionId: string;
	claimCount: number;
}

export interface L1Verification {
	danglingCitations: string[]; // 报告引用了不存在的 evidence id
	unsupportedClaims: string[]; // 无 evidenceIds 的 claim
	untraceableEvidence: string[]; // quote 无法在正文定位
	unusedEvidence: string[]; // 收集但未被引用（仅告警）
	fuzzySoleSupport: string[]; // 仅由 fuzzy 证据支撑的 claim（告警）
	coverage: CoverageEntry[];
	uncoveredCriteria: string[];
	passed: boolean;
}

export type L2Verdict = "supported" | "unsupported" | "conflicting" | "uncertain";

export interface L2ClaimVerdict {
	claimId: string;
	verdict: L2Verdict;
	reason: string;
	citedEvidenceIds: string[];
}

export interface VerificationReport {
	l1: L1Verification;
	l2: L2ClaimVerdict[];
	l2Skipped?: string; // 预算不足或 failed 时跳过 L2 的原因
}

// ============================================================================
// 能力 6 — 失败与预算
// ============================================================================

export type FailureType =
	// L1 工具级
	| "timeout"
	| "network"
	| "rate_limit"
	| "http_4xx"
	| "http_5xx"
	| "parse_error"
	| "blocked_url"
	// L2 Task 级
	| "no_search_result"
	| "all_fetch_failed"
	| "insufficient_evidence"
	| "quote_unverifiable"
	| "task_exception"
	// L3 Run 级
	| "repeated_task_failure"
	| "budget_exceeded"
	| "verification_failed";

export type RecoveryOutcome = "recovered" | "degraded" | "gaveUp";

export interface RecoveryEvent {
	ts: number;
	level: "tool" | "task" | "run";
	taskId?: string;
	failureType: FailureType;
	strategy: string; // "exponential_backoff" | "query_rewrite:zh_to_en" ...
	attempt: number;
	outcome: RecoveryOutcome;
	detail: string;
}

export type BudgetDimension = "tokens" | "cost" | "time";

export interface Budget {
	maxTokens: number;
	maxCostUsd: number;
	maxWallClockMs: number;
	maxTasks: number;
	maxFetchPerTask: number;
	usedTokens: number;
	usedCostUsd: number;
	startedAt: number;
	tripped?: BudgetDimension;
}

// ============================================================================
// 事件流（§4.0.1）— run.json 是权威快照，事件流补齐快照之后发生的事
// ============================================================================

/** 各事件的载荷（不含 envelope 的 seq/ts/runId） */
export interface ResearchEventPayloadMap {
	phase_enter: { phase: RunStatus };
	brief_ready: { brief: ResearchBrief };
	plan_ready: { plan: ResearchPlan };
	task_start: { taskId: string };
	task_end: { taskId: string; status: TaskStatus; evidenceCount: number };
	source_added: { source: Source };
	tool_call: {
		taskId: string;
		tool: string;
		argsHash: string; // sha256(规范化参数)，幂等键
		latencyMs: number;
		ok: boolean;
		failureType?: FailureType;
	};
	evidence_added: { evidence: Evidence };
	claims_ready: { claims: Claim[] };
	recovery: { event: RecoveryEvent };
	budget_trip: { dimension: BudgetDimension; usedTokens: number; usedCostUsd: number };
	blocked_url: { url: string; reason: string };
	verification_done: { report: VerificationReport };
	run_end: { status: RunStatus };
}

export type ResearchEventType = keyof ResearchEventPayloadMap;

/** 事件 = envelope + 判别联合载荷（判别字段 type 在交叉左侧，保证可分配） */
export type ResearchEvent = { seq: number; ts: number; runId: string } & {
	[K in ResearchEventType]: { type: K } & ResearchEventPayloadMap[K];
}[ResearchEventType];

/** 去掉 seq/ts/runId 的事件载荷，由 checkpoint 单点补齐 envelope */
export type ResearchEventPayload<T extends ResearchEventType = ResearchEventType> = {
	[K in ResearchEventType]: { type: K } & ResearchEventPayloadMap[K];
}[T];
