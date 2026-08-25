/**
 * ResearchOrchestrator（PRD §3）。
 *
 * 全流程：comprehending → planning → researching → reporting → verifying(L1)。
 * L2 语义校验在 M7 接入。
 *
 * 事件纪律（§4.0.1）：先 appendEvent，阶段结束时 writeSnapshot。
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { ResearchCache, SEARCH_CACHE_TTL_MS } from "../net/cache.ts";
import { fetchWithRetry } from "../net/http.ts";
import { createTavilyProvider } from "../providers/tavily.ts";
import type { SearchProvider } from "../providers/types.ts";
import { renderGaps } from "../report/gaps.ts";
import { exportRunHtml } from "../report/html.ts";
import { removeViolatingCitations, renderReport } from "../report/markdown.ts";
import { comprehend } from "../roles/comprehender.ts";
import { executeTask } from "../roles/executor.ts";
import { plan } from "../roles/planner.ts";
import { report } from "../roles/reporter.ts";
import { l1ErrorMessages, verifyL1 } from "../roles/verifier-l1.ts";
import { isAllSupported, verifyL2 } from "../roles/verifier-l2.ts";
import type { ToolEnv } from "../tools/env.ts";
import type { L2ClaimVerdict, ResearchBrief, ResearchRun, Task } from "../types.ts";
import { checkBudgetTrip, compensateBudgetIdleGap, reportingGate } from "./budget.ts";
import { CheckpointStore, readEvents } from "./checkpoint.ts";
import { FailureTracker, runTaskWithRecovery, shouldReplan } from "./failure-policy.ts";
import { replayEvents } from "./replay.ts";
import { runWithConcurrency, topologicalLayers } from "./scheduler.ts";

export interface OrchestrateOptions {
	query: string;
	model: Model<any>;
	/** 工作区根目录，run 产物落在 <cwd>/.codebuddy/research/<runId>/ */
	cwd: string;
	/**
	 * Brief 确认钩子（§10.3，默认开启的唯一人工纠偏窗口）。
	 * 返回 true 继续，false 取消。非交互模式不传入（自动继续）。
	 */
	confirmBrief?: (brief: ResearchBrief) => Promise<boolean>;
	/** 搜索 provider，默认 Tavily（测试注入 mock） */
	searchProvider?: SearchProvider;
	/** 抓取器，默认 http.fetchWithRetry（测试注入桩） */
	fetcher?: ToolEnv["fetcher"];
	/** Task 并发度，默认 1（串行） */
	concurrency?: number;
	/** --research-fresh：跳过全部缓存 */
	fresh?: boolean;
	/** 单次 LLM 调用的成本预算（美元），默认 2.0 */
	budgetUsd?: number;
	apiKey?: string;
	/** OAuth 类 provider 的额外请求头（经 modelRegistry 解析透传） */
	headers?: Record<string, string>;
	signal?: AbortSignal;
	onProgress?: (text: string) => void;
}

export interface OrchestrateResult {
	run: ResearchRun;
	runDir: string;
	cancelled: boolean;
}

function makeRunId(now = new Date()): string {
	const pad = (n: number, w = 2) => String(n).padStart(w, "0");
	const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	const suffix = Math.random().toString(36).slice(2, 5);
	return `${stamp}-${suffix}`;
}

function newRun(id: string, query: string, budgetUsd: number): ResearchRun {
	const now = Date.now();
	return {
		id,
		query,
		status: "comprehending",
		createdAt: now,
		updatedAt: now,
		schemaVersion: 1,
		sources: [],
		evidence: [],
		claims: [],
		budget: {
			maxTokens: 400_000,
			maxCostUsd: budgetUsd,
			maxWallClockMs: 15 * 60_000,
			maxTasks: 8,
			maxFetchPerTask: 5,
			usedTokens: 0,
			usedCostUsd: 0,
			startedAt: now,
		},
		recoveries: [],
		lastSeq: 0,
	};
}

export async function orchestrate(options: OrchestrateOptions): Promise<OrchestrateResult> {
	const runId = makeRunId();
	const runDir = join(options.cwd, ".codebuddy", "research", runId);
	const store = await CheckpointStore.create(runDir, runId);
	const run = newRun(runId, options.query, options.budgetUsd ?? 2.0);

	const snapshot = async () => {
		run.lastSeq = store.currentSeq;
		run.updatedAt = Date.now();
		await store.writeSnapshot(run);
	};

	// ── Phase 1: comprehending ─────────────────────────────────
	await store.appendEvent({ type: "phase_enter", phase: "comprehending" });
	options.onProgress?.("理解目标中…");
	const comprehended = await comprehend({
		model: options.model,
		query: options.query,
		apiKey: options.apiKey,
		headers: options.headers,
		signal: options.signal,
	});
	run.brief = comprehended.brief;
	await store.appendEvent({ type: "brief_ready", brief: comprehended.brief });
	if (comprehended.degraded) {
		await store.appendEvent({
			type: "recovery",
			event: {
				ts: Date.now(),
				level: "run",
				failureType: "task_exception",
				strategy: "fallback_brief",
				attempt: 1,
				outcome: "degraded",
				detail: "Comprehender 两次输出未通过约束校验，使用降级 Brief",
			},
		});
	}
	await snapshot();

	// Brief 确认（唯一人工纠偏窗口）
	if (options.confirmBrief) {
		const confirmed = await options.confirmBrief(comprehended.brief);
		if (!confirmed) {
			run.status = "cancelled";
			await store.appendEvent({ type: "run_end", status: "cancelled" });
			await snapshot();
			return { run, runDir, cancelled: true };
		}
	}

	// ── Phase 2: planning ──────────────────────────────────────
	run.status = "planning";
	await store.appendEvent({ type: "phase_enter", phase: "planning" });
	options.onProgress?.("规划研究任务中…");
	const planned = await plan({
		model: options.model,
		brief: comprehended.brief,
		apiKey: options.apiKey,
		headers: options.headers,
		signal: options.signal,
	});
	run.plan = planned.plan;
	await store.appendEvent({ type: "plan_ready", plan: planned.plan });
	if (planned.usedFallbackTasks) {
		await store.appendEvent({
			type: "recovery",
			event: {
				ts: Date.now(),
				level: "run",
				failureType: "verification_failed",
				strategy: "fallback_tasks",
				attempt: 1,
				outcome: "degraded",
				detail: "Planner 覆盖度校验未通过，未覆盖项已用兜底 Task 补齐",
			},
		});
	}
	await snapshot();

	// ── Phase 3: researching ───────────────────────────────────
	run.status = "researching";
	await store.appendEvent({ type: "phase_enter", phase: "researching" });
	options.onProgress?.(`开始研究（${planned.plan.tasks.length} 个任务）…`);

	const env: ToolEnv = {
		run,
		store,
		cache: new ResearchCache(runDir),
		searchProvider: options.searchProvider ?? createTavilyProvider(),
		fetcher: options.fetcher ?? fetchWithRetry,
		searchCacheTtlMs: SEARCH_CACHE_TTL_MS,
		fresh: options.fresh ?? false,
		fetchCountByTask: new Map(),
		seq: { source: 1, evidence: 1 },
		failureTracker: new FailureTracker(),
		signal: options.signal,
	};

	// M6：Task 级恢复包装（task_exception 重跑 + insufficient 补充子任务）
	const executeWithRecovery = async (task: Task, execOpts?: { queryOverride?: string }) => {
		const effectiveTask = execOpts?.queryOverride ? { ...task, query: execOpts.queryOverride } : task;
		const outcome = await executeTask(env, effectiveTask, {
			model: options.model,
			apiKey: options.apiKey,
			headers: options.headers,
			signal: options.signal,
		});
		// 补充子任务收集的证据并回原 task（evidence.taskId 归属不变）
		task.evidenceCount = effectiveTask.evidenceCount;
		return outcome;
	};

	const runOneTask = async (task: Task) => {
		task.status = "running";
		task.startedAt = Date.now();
		await store.appendEvent({ type: "task_start", taskId: task.id });
		options.onProgress?.(`[${task.id}] ${task.title} …`);

		const outcome = await runTaskWithRecovery(task, {
			executeTask: executeWithRecovery,
			recordRecovery: async (event) => {
				const full = { ts: Date.now(), level: "task" as const, ...event } as never;
				run.recoveries.push(full);
				await store.appendEvent({ type: "recovery", event: full });
			},
		});

		task.status = outcome.status;
		task.finishedAt = Date.now();
		task.attempts++;
		if (outcome.error) task.lastError = outcome.error;
		await store.appendEvent({
			type: "task_end",
			taskId: task.id,
			status: outcome.status,
			evidenceCount: task.evidenceCount,
		});
		if (outcome.degraded) {
			await store.appendEvent({
				type: "recovery",
				event: {
					ts: Date.now(),
					level: "task",
					taskId: task.id,
					failureType: "insufficient_evidence",
					strategy: "accept_degraded",
					attempt: 1,
					outcome: "degraded",
					detail: `证据不足（${task.evidenceCount}/${task.minEvidence}），降级完成`,
				},
			});
		}
		// M6：每个 Task 结束检查预算熔断
		await checkBudgetTrip(run, store);
		await snapshot();
		options.onProgress?.(
			`[${task.id}] ${outcome.status === "success" ? "✓" : "⚠"} ${task.evidenceCount} 条证据${run.budget.tripped ? `，预算熔断(${run.budget.tripped})` : ""}`,
		);
	};

	const layers = topologicalLayers(planned.plan.tasks);
	for (const layer of layers) {
		await runWithConcurrency(layer, options.concurrency ?? 1, runOneTask);
		// 预算熔断：停止调度后续 Task
		if (run.budget.tripped !== undefined) break;
	}

	// M6 L3：repeated_task_failure（≥30%）→ Re-plan 1 次
	if (shouldReplan(planned.plan.tasks, planned.plan.replanCount) && run.budget.tripped === undefined) {
		planned.plan.replanCount++;
		const failedTasks = planned.plan.tasks.filter((t) => t.status === "failed" || t.status === "unresolved");
		run.recoveries.push({
			ts: Date.now(),
			level: "run",
			failureType: "repeated_task_failure",
			strategy: "replan",
			attempt: 1,
			outcome: "degraded",
			detail: `${failedTasks.length}/${planned.plan.tasks.length} 任务失败（≥30%），触发 Re-plan`,
		});
		await store.appendEvent({ type: "recovery", event: run.recoveries[run.recoveries.length - 1] });
		options.onProgress?.(`${failedTasks.length} 个任务失败，触发 Re-plan 重新规划…`);

		const replanned = await plan({
			model: options.model,
			brief: run.brief!,
			apiKey: options.apiKey,
			headers: options.headers,
			signal: options.signal,
		});
		// 用重规划的任务替换失败任务（保留已成功任务与其证据）
		const replacementTasks = replanned.plan.tasks
			.filter((t) => t.criterionIds.some((id) => failedTasks.some((f) => f.criterionIds.includes(id))))
			.map((t, i) => ({ ...t, id: `R${i + 1}` }));
		if (replacementTasks.length > 0) {
			planned.plan.tasks.push(...replacementTasks);
			await store.appendEvent({ type: "plan_ready", plan: planned.plan });
			const replanLayers = topologicalLayers(replacementTasks);
			for (const layer of replanLayers) {
				await runWithConcurrency(layer, options.concurrency ?? 1, runOneTask);
				if (run.budget.tripped !== undefined) break;
			}
		}
	}

	// ── Phase 4+5: reporting & verifying（抽为独立函数，resume 复用）──
	return runReportingPhase(run, runDir, store, snapshot, options);
}

/**
 * reporting → verifying(L1+L2) → 终态组装（orchestrate 与 resume 共用）。
 * 前置：run.brief 存在、run.evidence 已收集（可能为 0）。
 */
async function runReportingPhase(
	run: ResearchRun,
	runDir: string,
	store: CheckpointStore,
	snapshot: () => Promise<void>,
	options: OrchestrateOptions,
): Promise<OrchestrateResult> {
	// ── Phase 4: reporting（M6：前置门禁 §8.4）─────────────────
	const gate = reportingGate(run);
	if (gate.action === "failed_stub") {
		run.status = "failed";
		run.report = buildStubReport(run, gate.reason);
		await store.appendEvent({ type: "run_end", status: "failed" });
		await writeReport(runDir, run.report);
		await snapshot();
		options.onProgress?.(`研究终止：${gate.reason}，已落盘存根。`);
		return { run, runDir, cancelled: false };
	}
	const degradedReporting = gate.action === "proceed_degraded";

	run.status = "reporting";
	await store.appendEvent({ type: "phase_enter", phase: "reporting" });
	options.onProgress?.(
		`研究完成：共 ${run.evidence.length} 条证据。生成报告中${degradedReporting ? "（预算熔断，跳过修正轮与 L2）" : "…"}`,
	);

	const reported = await report({
		model: options.model,
		input: { brief: run.brief!, query: run.query, evidence: run.evidence, sources: run.sources },
		apiKey: options.apiKey,
		headers: options.headers,
		signal: options.signal,
	});

	if (!reported.ok) {
		// Reporter 失败：failed + 存根报告（§8.4 前置门禁语义）
		run.status = "failed";
		run.report = buildStubReport(run, `报告生成失败：${reported.reason}`);
		await store.appendEvent({ type: "run_end", status: "failed" });
		await writeReport(runDir, run.report);
		await snapshot();
		options.onProgress?.("报告生成失败，已落盘存根。");
		return { run, runDir, cancelled: false };
	}

	run.claims = reported.claims!;
	await store.appendEvent({ type: "claims_ready", claims: run.claims });

	// 渲染：剥离 LLM 自写的定义行，代码重建脚注
	const sourcesByEvidence = new Map(
		run.evidence
			.map((e) => [e.id, run.sources.find((s) => s.id === e.sourceId)])
			.filter((pair): pair is [string, (typeof run.sources)[number]] => pair[1] !== undefined),
	);
	const evidenceIdSet = new Set(run.evidence.map((e) => e.id));
	let rendered = renderReport(reported.markdown!, evidenceIdSet, sourcesByEvidence);

	// ── Phase 5: verifying (L1) ────────────────────────────────
	run.status = "verifying";
	await store.appendEvent({ type: "phase_enter", phase: "verifying" });

	let l1 = await verifyL1({ run, store, renderedMarkdown: rendered.markdown });
	let finalMarkdown = rendered.markdown;

	if (!l1.passed && !run.budget.tripped) {
		// 回灌修正 1 次（硬上限）
		const errors = l1ErrorMessages(l1);
		options.onProgress?.(`L1 校验未通过（${errors.length} 类问题），回灌修正中…`);
		const revised = await report({
			model: options.model,
			input: { brief: run.brief!, query: run.query, evidence: run.evidence, sources: run.sources },
			apiKey: options.apiKey,
			headers: options.headers,
			signal: options.signal,
			previousErrors: errors,
		});
		if (revised.ok) {
			run.claims = revised.claims!;
			await store.appendEvent({ type: "claims_ready", claims: run.claims });
			rendered = renderReport(revised.markdown!, evidenceIdSet, sourcesByEvidence);
			const l1Second = await verifyL1({ run, store, renderedMarkdown: rendered.markdown });
			if (l1Second.passed) {
				l1 = l1Second;
				finalMarkdown = rendered.markdown;
			} else {
				// 修正失败：确定性剔除违规引用
				l1 = l1Second;
				finalMarkdown = removeViolatingCitations(rendered.markdown, new Set(l1.danglingCitations));
				run.claims = run.claims.filter((c) => !c.evidenceIds.some((id) => l1.danglingCitations.includes(id)));
				finalMarkdown = renderReport(finalMarkdown, evidenceIdSet, sourcesByEvidence).markdown;
			}
		} else {
			// 修正轮 Reporter 失败：剔除违规引用
			finalMarkdown = removeViolatingCitations(rendered.markdown, new Set(l1.danglingCitations));
			run.claims = run.claims.filter((c) => !c.evidenceIds.some((id) => l1.danglingCitations.includes(id)));
			finalMarkdown = renderReport(finalMarkdown, evidenceIdSet, sourcesByEvidence).markdown;
		}
	} else if (!l1.passed && run.budget.tripped) {
		// 预算熔断：跳过回灌，直接剔除
		finalMarkdown = removeViolatingCitations(rendered.markdown, new Set(l1.danglingCitations));
		run.claims = run.claims.filter((c) => !c.evidenceIds.some((id) => l1.danglingCitations.includes(id)));
		finalMarkdown = renderReport(finalMarkdown, evidenceIdSet, sourcesByEvidence).markdown;
	}

	// ── Phase 5b: L2 语义校验（M7，独立上下文；预算熔断时跳过）──────
	let l2: L2ClaimVerdict[] = [];
	let l2Skipped: string | undefined;
	if (run.budget.tripped !== undefined) {
		l2Skipped = "budget";
	} else if (run.claims.length > 0) {
		options.onProgress?.(`L1 通过，对 ${run.claims.length} 条结论做语义校验…`);
		l2 = await verifyL2({
			model: options.model,
			claims: run.claims,
			evidence: run.evidence,
			sources: run.sources,
			apiKey: options.apiKey,
			headers: options.headers,
			signal: options.signal,
		});
	}

	// 终态判定 + 报告组装
	const hasUnresolved = (run.plan?.tasks ?? []).some((t) => t.status === "unresolved" || t.status === "failed");
	const passed = l1.passed && !hasUnresolved && run.claims.length > 0;
	run.status = run.claims.length === 0 ? "failed" : passed ? "completed" : "partial";

	const gaps = renderGaps(run);
	const l1Note = l1.passed
		? `- 结构校验：通过（0 悬空引用，${l1.coverage.filter((c) => c.claimCount > 0).length}/${l1.coverage.length} 判据覆盖）`
		: `- 结构校验：降级通过（剔除 ${l1.danglingCitations.length} 处违规引用后结报）`;

	const l2Notes: string[] = [];
	if (l2Skipped) {
		l2Notes.push(`- 语义校验（L2）：已跳过（${l2Skipped}）`);
	} else if (l2.length > 0) {
		const counts = { supported: 0, unsupported: 0, conflicting: 0, uncertain: 0 };
		for (const v of l2) counts[v.verdict]++;
		l2Notes.push(
			`- 语义校验：${l2.length} 条结论中 ${counts.supported} supported、${counts.conflicting} conflicting、${counts.uncertain} uncertain、${counts.unsupported} unsupported`,
		);
		// §7.2：全部 supported 是橡皮图章信号，主动标注可信度存疑
		if (isAllSupported(l2)) {
			l2Notes.push(`- ⚠ 语义校验未产生任何异议：全部判 supported，校验结果可信度存疑（可能存在同源偏差）`);
		}
		const conflicting = l2.filter((v) => v.verdict === "conflicting" || v.verdict === "unsupported");
		for (const v of conflicting.slice(0, 5)) {
			l2Notes.push(`  - ${v.claimId}（${v.verdict}）：${v.reason}`);
		}
	}

	const verificationSection = ["", "## 校验结果", "", l1Note, ...l2Notes].join("\n");

	run.report = [finalMarkdown.trimEnd(), gaps, verificationSection].filter(Boolean).join("\n\n");
	run.verification = { l1, l2, l2Skipped };

	await store.appendEvent({ type: "verification_done", report: run.verification });
	await store.appendEvent({ type: "run_end", status: run.status });
	await writeReport(runDir, run.report);

	// HTML 溯源报告：展示层产物，导出失败绝不影响 run 终态（仅记 warning）
	try {
		const htmlPath = await exportRunHtml(runDir, run, run.report);
		options.onProgress?.(`HTML 溯源报告：${htmlPath}`);
	} catch (err) {
		options.onProgress?.(`HTML 导出失败（不影响报告）：${err instanceof Error ? err.message : String(err)}`);
	}

	await snapshot();

	options.onProgress?.(`报告完成：${run.status}，${run.claims.length} 条结论。${join(runDir, "report.md")}`);

	return { run, runDir, cancelled: false };
}

/** 失败存根报告（§8.4 前置门禁：failed 也落盘，说明原因与已完成部分） */
function buildStubReport(run: ResearchRun, reason: string): string {
	const brief = run.brief;
	const plannedTasks = run.plan?.tasks ?? [];
	const doneTasks = plannedTasks.filter((t) => t.status === "success");
	return [
		`# 研究未完成：${run.query}`,
		"",
		`状态：failed（${reason}）`,
		`已用：↑${run.budget.usedTokens} tokens  $${run.budget.usedCostUsd.toFixed(4)}`,
		"",
		"## 已完成的部分",
		"",
		brief ? `- 研究目标已明确：${brief.goal}` : "- （目标理解未完成）",
		plannedTasks.length > 0
			? `- 已规划 ${plannedTasks.length} 个任务，其中 ${doneTasks.length} 个完成`
			: "- （任务规划未完成）",
		`- 已收集 ${run.evidence.length} 条证据（见 run.json）`,
		"",
		"## 建议",
		"",
		`调整预算或网络后，可用完整数据（${run.id}）重新研究。`,
	].join("\n");
}

/** 原子落盘 report.md */
async function writeReport(runDir: string, markdown: string): Promise<void> {
	const path = join(runDir, "report.md");
	const tmp = `${path}.tmp`;
	await writeFile(tmp, markdown, "utf8");
	const { rename } = await import("node:fs/promises");
	await rename(tmp, path);
}

// ============================================================================
// Resume（PRD §8.4 crash 策略，验收 A9）
// ============================================================================

/**
 * 从快照 + 事件流恢复现场，返回可续跑的起点。
 * 规则（§4.0.1）：run.json 是权威快照，重放 seq > lastSeq 的事件补齐；
 * resume 从第一个未完成的阶段/任务继续（不依赖 run_end）。
 */
export async function resumeRun(options: OrchestrateOptions & { runId: string }): Promise<OrchestrateResult> {
	const runDir = join(options.cwd, ".codebuddy", "research", options.runId);
	const snapshotPath = join(runDir, "run.json");

	let snapshot: ResearchRun;
	try {
		snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as ResearchRun;
	} catch {
		throw new Error(`无法读取 run 快照：${snapshotPath}（run 不存在或已损坏）`);
	}

	const events = await readEvents(join(runDir, "events.jsonl"));
	const { run, succeededToolCalls, resumeFromTaskId } = replayEvents(snapshot, events);
	const store = await CheckpointStore.open(runDir, run);

	options.onProgress?.(`恢复 run ${options.runId}：状态 ${run.status}，已应用 ${events.length} 条事件`);

	// run 已结束（有 run_end 或终态）→ 拒绝续跑
	const finalEvents = events.filter((e) => e.type === "run_end");
	if (finalEvents.length > 0 || run.status === "completed" || run.status === "partial" || run.status === "failed") {
		options.onProgress?.(`该 run 已结束（${run.status}），无需续跑。报告：${join(runDir, "report.md")}`);
		return { run, runDir, cancelled: false };
	}

	// A9 修复：崩溃/中断的闲置时长不计入 wall-clock 预算，顺延计时起点
	const gapMs = compensateBudgetIdleGap(run);
	if (gapMs > 0) {
		options.onProgress?.(`预算计时起点顺延 ${Math.round(gapMs / 1000)}s（崩溃中断时长不计入）`);
	}

	// 续跑：从未完成阶段继续。M7 实现 researching 阶段的续跑；
	// comprehending/planning 阶段极快，崩溃概率低，直接重跑整个 orchestrate 更简单。
	if (run.status === "researching" && run.plan) {
		return resumeResearching(run, runDir, store, succeededToolCalls, resumeFromTaskId, options);
	}

	// 其他阶段：回到主流程重跑（comprehend/plan 会重做，但幂等）
	options.onProgress?.(`状态 ${run.status} 不支持增量续跑，从头重跑。`);
	return orchestrate(options);
}

/** researching 阶段的续跑：跳过已完成 Task，从第一个 pending/running Task 继续 */
async function resumeResearching(
	run: ResearchRun,
	runDir: string,
	store: CheckpointStore,
	_succeededToolCalls: Set<string>,
	resumeFromTaskId: string | undefined,
	options: OrchestrateOptions,
): Promise<OrchestrateResult> {
	const tasks = run.plan!.tasks;
	// A9 修复：崩溃中断的 running 任务（有 task_start 无 task_end）先收尾——按已记录的
	// 证据数判定终态并补 task_end 事件。不重跑：避免重复消耗 LLM tokens 与重复记录证据，
	// 崩溃任务拿到多少算多少，符合 §8.4 失败收敛原则。
	for (const task of tasks) {
		if (task.status !== "running") continue;
		task.evidenceCount = run.evidence.filter((e) => e.taskId === task.id).length;
		task.status = task.evidenceCount >= task.minEvidence ? "success" : "unresolved";
		task.finishedAt = run.updatedAt;
		await store.appendEvent({
			type: "task_end",
			taskId: task.id,
			status: task.status,
			evidenceCount: task.evidenceCount,
		});
		options.onProgress?.(`[${task.id}] 崩溃中断收尾：${task.evidenceCount} 条证据 → ${task.status}`);
	}
	const pendingTasks = resumeFromTaskId ? tasks.filter((t) => t.status === "pending") : [];
	if (pendingTasks.length === 0) {
		options.onProgress?.("所有任务已完成，进入报告阶段（由主流程处理）。");
	}

	// 复用主流程的 env 构造（缓存仍在 runDir 下，搜索/抓取缓存命中）
	const env: ToolEnv = {
		run,
		store,
		cache: new ResearchCache(runDir),
		searchProvider: options.searchProvider ?? createTavilyProvider(),
		fetcher: options.fetcher ?? fetchWithRetry,
		searchCacheTtlMs: SEARCH_CACHE_TTL_MS,
		fresh: options.fresh ?? false,
		fetchCountByTask: new Map(),
		seq: {
			source: run.sources.length + 1,
			evidence: run.evidence.length + 1,
		},
		failureTracker: new FailureTracker(),
		signal: options.signal,
	};

	const snapshot = async () => {
		run.lastSeq = store.currentSeq;
		run.updatedAt = Date.now();
		await store.writeSnapshot(run);
	};

	const layers = topologicalLayers(pendingTasks);
	for (const layer of layers) {
		for (const task of layer) {
			task.status = "running";
			task.startedAt = Date.now();
			await store.appendEvent({ type: "task_start", taskId: task.id });
			options.onProgress?.(`[${task.id}] ${task.title} …（续跑）`);

			const outcome = await executeTask(env, task, {
				model: options.model,
				apiKey: options.apiKey,
				headers: options.headers,
				signal: options.signal,
			});

			task.status = outcome.status;
			task.finishedAt = Date.now();
			task.attempts++;
			if (outcome.error) task.lastError = outcome.error;
			await store.appendEvent({
				type: "task_end",
				taskId: task.id,
				status: outcome.status,
				evidenceCount: task.evidenceCount,
			});
			await checkBudgetTrip(run, store);
			await snapshot();
		}
		if (run.budget.tripped !== undefined) break;
	}

	// 续跑完 Task 后接着走完 reporting/verifying（M8：resume 必须能出报告）
	options.onProgress?.(`续跑完成：共 ${run.evidence.length} 条证据。进入报告阶段…`);
	return runReportingPhase(run, runDir, store, snapshot, options);
}
