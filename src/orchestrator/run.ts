/**
 * ResearchOrchestrator（PRD §3）。
 *
 * M3 交付范围：comprehending → planning 两个阶段 + checkpoint。
 * researching / reporting / verifying 在 M4~M7 接入。
 *
 * 事件纪律（§4.0.1）：先 appendEvent，阶段结束时 writeSnapshot。
 */

import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { ResearchCache, SEARCH_CACHE_TTL_MS } from "../net/cache.ts";
import { fetchWithRetry } from "../net/http.ts";
import { createTavilyProvider } from "../providers/tavily.ts";
import type { SearchProvider } from "../providers/types.ts";
import { comprehend } from "../roles/comprehender.ts";
import { executeTask } from "../roles/executor.ts";
import { plan } from "../roles/planner.ts";
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
		nextSourceSeq: 1,
		nextEvidenceSeq: 1,
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

	// reporting / verifying 阶段：M5~M7 接入
	options.onProgress?.(`研究完成：共 ${run.evidence.length} 条证据。报告生成将在下一里程碑接入。`);

	return { run, runDir, cancelled: false };
}
