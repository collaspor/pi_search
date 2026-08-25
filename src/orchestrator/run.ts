/**
 * ResearchOrchestrator（PRD §3）。
 *
 * 全流程：comprehending → planning → researching → reporting → verifying(L1)。
 * L2 语义校验在 M7 接入。
 *
 * 事件纪律（§4.0.1）：先 appendEvent，阶段结束时 writeSnapshot。
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { ResearchCache, SEARCH_CACHE_TTL_MS } from "../net/cache.ts";
import { fetchWithRetry } from "../net/http.ts";
import { createTavilyProvider } from "../providers/tavily.ts";
import type { SearchProvider } from "../providers/types.ts";
import { renderGaps } from "../report/gaps.ts";
import { removeViolatingCitations, renderReport } from "../report/markdown.ts";
import { comprehend } from "../roles/comprehender.ts";
import { executeTask } from "../roles/executor.ts";
import { plan } from "../roles/planner.ts";
import { report } from "../roles/reporter.ts";
import { l1ErrorMessages, verifyL1 } from "../roles/verifier-l1.ts";
import type { ToolEnv } from "../tools/env.ts";
import type { ResearchBrief, ResearchRun, Task } from "../types.ts";
import { CheckpointStore } from "./checkpoint.ts";
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
	};

	const layers = topologicalLayers(planned.plan.tasks);
	for (const layer of layers) {
		await runWithConcurrency(layer, options.concurrency ?? 1, async (task: Task) => {
			task.status = "running";
			task.startedAt = Date.now();
			await store.appendEvent({ type: "task_start", taskId: task.id });
			options.onProgress?.(`[${task.id}] ${task.title} …`);

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
			await snapshot();
			options.onProgress?.(
				`[${task.id}] ${outcome.status === "success" ? "✓" : "⚠"} ${task.evidenceCount} 条证据，${(outcome.usedTokens / 1000).toFixed(1)}k tokens`,
			);
		});
	}

	// ── Phase 4: reporting ─────────────────────────────────────
	run.status = "reporting";
	await store.appendEvent({ type: "phase_enter", phase: "reporting" });
	options.onProgress?.(`研究完成：共 ${run.evidence.length} 条证据。生成报告中…`);

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

	// 终态判定 + 报告组装
	const hasUnresolved = (run.plan?.tasks ?? []).some((t) => t.status === "unresolved" || t.status === "failed");
	const passed = l1.passed && !hasUnresolved && run.claims.length > 0;
	run.status = run.claims.length === 0 ? "failed" : passed ? "completed" : "partial";

	const gaps = renderGaps(run);
	const l1Note = l1.passed
		? `- 结构校验：通过（0 悬空引用，${l1.coverage.filter((c) => c.claimCount > 0).length}/${l1.coverage.length} 判据覆盖）`
		: `- 结构校验：降级通过（剔除 ${l1.danglingCitations.length} 处违规引用后结报）`;
	const verificationSection = ["", "## 校验结果", "", l1Note, `- 语义校验（L2）：将在下一里程碑接入`].join("\n");

	run.report = [finalMarkdown.trimEnd(), gaps, verificationSection].filter(Boolean).join("\n\n");
	run.verification = { l1, l2: [], l2Skipped: "L2 将在 M7 接入" };

	await store.appendEvent({ type: "verification_done", report: run.verification });
	await store.appendEvent({ type: "run_end", status: run.status });
	await writeReport(runDir, run.report);
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
