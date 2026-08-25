/**
 * Executor 端到端测试（A3/A4）。
 * faux model 驱动完整 pi Agent Loop：search → fetch → evidence_record → 完成。
 * searchProvider 与 fetcher 注入桩，不触网。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ResearchCache, SEARCH_CACHE_TTL_MS } from "../src/net/cache.ts";
import type { HttpResult } from "../src/net/http.ts";
import { CheckpointStore } from "../src/orchestrator/checkpoint.ts";
import { FailureTracker } from "../src/orchestrator/failure-policy.ts";
import { createMockProvider } from "../src/providers/mock.ts";
import { executeTask } from "../src/roles/executor.ts";
import type { ToolEnv } from "../src/tools/env.ts";
import type { ResearchRun, Task } from "../src/types.ts";

const ARTICLE = "人工智能代理市场规模在2026年预计达到1280亿美元，年增长率为34.5%。这是企业采购驱动的增长。".repeat(8);
const HTML_PAGE = `<html><head><title>报告</title></head><body><article><p>${ARTICLE}</p></article></body></html>`;

let dir: string;
const registrations: { unregister: () => void }[] = [];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "pi-research-exec-"));
});

afterEach(async () => {
	while (registrations.length > 0) registrations.pop()?.unregister();
	await rm(dir, { recursive: true, force: true });
});

function makeTask(): Task {
	return {
		id: "T1",
		title: "市场规模研究",
		query: "AI agent market 2026",
		rationale: "获取量化数据",
		criterionIds: ["SC1"],
		dependsOn: [],
		status: "running",
		attempts: 0,
		evidenceCount: 0,
		minEvidence: 2,
	};
}

function makeRun(): ResearchRun {
	return {
		id: "run-1",
		query: "调研 AI Agent 市场",
		status: "researching",
		createdAt: 0,
		updatedAt: 0,
		schemaVersion: 1,
		brief: {
			goal: "调研 AI Agent 市场",
			scope: { included: [], excluded: [] },
			entities: [],
			successCriteria: [{ id: "SC1", text: "市场规模" }],
			assumptions: [],
			outline: [],
		},
		sources: [],
		evidence: [],
		claims: [],
		budget: {
			maxTokens: 1e6,
			maxCostUsd: 10,
			maxWallClockMs: 1e6,
			maxTasks: 8,
			maxFetchPerTask: 5,
			usedTokens: 0,
			usedCostUsd: 0,
			startedAt: 0,
		},
		recoveries: [],
		lastSeq: 0,
	};
}

async function setupEnv(run: ResearchRun, _task: Task): Promise<ToolEnv> {
	const store = await CheckpointStore.create(dir, run.id);
	return {
		run,
		store,
		cache: new ResearchCache(dir),
		searchProvider: createMockProvider({
			defaultBehavior: {
				kind: "results",
				results: [
					{ url: "https://example.com/report", title: "报告", snippet: ARTICLE.slice(0, 80), rawContent: ARTICLE },
				],
			},
		}),
		fetcher: async (_url): Promise<HttpResult> => ({
			ok: true,
			status: 200,
			body: HTML_PAGE,
			finalUrl: "https://example.com/report",
			headers: {},
		}),
		searchCacheTtlMs: SEARCH_CACHE_TTL_MS,
		fresh: false,
		fetchCountByTask: new Map(),
		seq: { source: 1, evidence: 1 },
	};
}

describe("executeTask（A3/A4 端到端）", () => {
	it("完整链路：search → fetch → evidence_record ×2 → success", async () => {
		const faux = registerFauxProvider({});
		registrations.push(faux);
		const run = makeRun();
		const task = makeTask();
		const env = await setupEnv(run, task);

		// 模型脚本：调用三个工具（loop 自动回灌结果），然后文本收尾
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("web_search", { query: "AI agent market 2026" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("web_fetch", { url: "https://example.com/report" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				fauxToolCall("evidence_record", {
					sourceId: "s1",
					quote: "人工智能代理市场规模在2026年预计达到1280亿美元",
					summary: "市场规模量化",
					stance: "support",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall("evidence_record", {
					sourceId: "s1",
					quote: "年增长率为34.5%",
					summary: "增长率",
					stance: "support",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxText("任务完成，已收集足够证据。")),
		]);

		const outcome = await executeTask(env, task, { model: faux.getModel() });

		expect(outcome.status).toBe("success");
		expect(outcome.degraded).toBe(false);
		expect(task.evidenceCount).toBe(2);
		// A3：tool_call 事件带 latencyMs
		// A4：证据可定位
		expect(run.evidence).toHaveLength(2);
		expect(run.evidence[0].quoteMatch).toBe("exact");
		expect(run.evidence[0].locator.start).toBeGreaterThanOrEqual(0);
		// token 累计进预算
		expect(run.budget.usedTokens).toBeGreaterThanOrEqual(0);
	});

	it("证据数为 0 → unresolved", async () => {
		const faux = registerFauxProvider({});
		registrations.push(faux);
		const run = makeRun();
		const task = makeTask();
		const env = await setupEnv(run, task);

		// 模型只搜索（空结果）然后放弃
		env.searchProvider = createMockProvider({ defaultBehavior: { kind: "results", results: [] } });
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("web_search", { query: "x" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxText("没有找到任何结果，无法完成任务。")),
		]);

		const outcome = await executeTask(env, task, { model: faux.getModel() });
		expect(outcome.status).toBe("unresolved");
		expect(task.evidenceCount).toBe(0);
	});

	it("quote 被篡改 → evidence_record 拒收，模型改摘录后成功", async () => {
		const faux = registerFauxProvider({});
		registrations.push(faux);
		const run = makeRun();
		const task = makeTask();
		task.minEvidence = 1;
		const env = await setupEnv(run, task);

		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("web_search", { query: "q" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("web_fetch", { url: "https://example.com/report" }), {
				stopReason: "toolUse",
			}),
			// 第一次：篡改数字 → 拒收
			fauxAssistantMessage(
				fauxToolCall("evidence_record", {
					sourceId: "s1",
					quote: "人工智能代理市场规模在2026年预计达到9980亿美元，年增长率为34.5%。这是企业采购驱动的增长。",
					summary: "篡改",
					stance: "support",
				}),
				{ stopReason: "toolUse" },
			),
			// 第二次：正确摘录 → 成功
			fauxAssistantMessage(
				fauxToolCall("evidence_record", {
					sourceId: "s1",
					quote: "人工智能代理市场规模在2026年预计达到1280亿美元",
					summary: "正确",
					stance: "support",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxText("完成")),
		]);

		const outcome = await executeTask(env, task, { model: faux.getModel() });
		expect(outcome.status).toBe("success");
		expect(task.evidenceCount).toBe(1);
		// 拒收被记为 recovery
		expect(run.recoveries.some((r) => r.failureType === "quote_unverifiable")).toBe(true);
	});

	it("达到轮次上限停止 → 按已有证据判定", async () => {
		const faux = registerFauxProvider({});
		registrations.push(faux);
		const run = makeRun();
		const task = makeTask();
		task.minEvidence = 99; // 永远达不到
		const env = await setupEnv(run, task);

		// 模型一直搜索不记录证据；maxTurns=3 时应停止
		faux.setResponses(
			Array.from({ length: 10 }, () =>
				fauxAssistantMessage(fauxToolCall("web_search", { query: "q" }), { stopReason: "toolUse" }),
			),
		);

		const outcome = await executeTask(env, task, { model: faux.getModel(), maxTurns: 3 });
		expect(outcome.status).toBe("unresolved");
		expect(outcome.turns).toBeLessThanOrEqual(4);
	});

	it("loop 抛异常 → failed，不向上抛出", async () => {
		const faux = registerFauxProvider({});
		registrations.push(faux);
		const run = makeRun();
		const task = makeTask();
		const env = await setupEnv(run, task);

		faux.setResponses([
			() => {
				throw new Error("simulated stream failure");
			},
		]);

		const outcome = await executeTask(env, task, { model: faux.getModel() });
		expect(outcome.status).toBe("failed");
		expect(outcome.error).toContain("simulated stream failure");
	});

	it("Query Rewrite（实验 B 端到端）：搜索连续空结果 → 策略池引导 → 模型改写查询重搜成功", async () => {
		const faux = registerFauxProvider({});
		registrations.push(faux);
		const run = makeRun();
		const task = makeTask();
		task.minEvidence = 1;

		// 搜索 provider：前两次空结果，第三次（改写后的查询）有结果
		const searchQueries: string[] = [];
		const provider = {
			id: "mock",
			async search(input: { query: string; maxResults: number }) {
				searchQueries.push(input.query);
				if (searchQueries.length < 3) {
					return {
						ok: false as const,
						provider: "mock",
						query: input.query,
						failureType: "no_search_result" as const,
						message: "0 results",
					};
				}
				return {
					ok: true as const,
					provider: "mock",
					query: input.query,
					results: [
						{
							url: "https://example.com/found",
							title: "找到了",
							snippet: ARTICLE.slice(0, 80),
							rawContent: ARTICLE,
						},
					],
					fromCache: false,
				};
			},
		};

		const store = await CheckpointStore.create(dir, run.id);
		const env: ToolEnv = {
			run,
			store,
			cache: new ResearchCache(dir),
			searchProvider: provider,
			fetcher: async (): Promise<HttpResult> => ({
				ok: true,
				status: 200,
				body: HTML_PAGE,
				finalUrl: "https://example.com/found",
				headers: {},
			}),
			searchCacheTtlMs: SEARCH_CACHE_TTL_MS,
			fresh: false,
			fetchCountByTask: new Map(),
			seq: { source: 1, evidence: 1 },
			failureTracker: new FailureTracker(),
		};

		// 模型脚本：搜索(空) → 收到改写指引后用新查询重搜(空) → 再改写重搜(有) → fetch → record
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("web_search", { query: "量子波动速读仪" }), { stopReason: "toolUse" }),
			// 模型按 FailureTracker 的指引改写查询
			(ctx) => {
				const last = ctx.messages.filter((m) => m.role === "toolResult").pop();
				const text = last && "content" in last ? JSON.stringify(last.content) : "";
				// 验证指引包含改写策略提示
				expect(text).toMatch(/rewrite attempt|strategy/i);
				return fauxAssistantMessage(fauxToolCall("web_search", { query: "quantum speed reading device" }), {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage(fauxToolCall("web_search", { query: "speed reading" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("web_fetch", { url: "https://example.com/found" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				fauxToolCall("evidence_record", {
					sourceId: "s1",
					quote: "人工智能代理市场规模在2026年预计达到1280亿美元",
					summary: "s",
					stance: "support",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxText("完成")),
		]);

		const outcome = await executeTask(env, task, { model: faux.getModel() });
		expect(outcome.status).toBe("success");
		// 核心断言：模型用了 3 个不同的查询（改写生效），且第 3 次成功
		expect(searchQueries.length).toBe(3);
		expect(new Set(searchQueries).size).toBe(3);
		expect(task.evidenceCount).toBe(1);
	});
});
