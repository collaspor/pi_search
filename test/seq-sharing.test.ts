/**
 * Bug1 修复验证：evidence/source id 跨 taskEnv 视图全局唯一。
 * 真实运行暴露的问题：浅拷贝 {...env} 复制 number 原始值导致各 Task id 重复。
 * 修复：seq 改为共享引用对象。本测试直接验证两个 taskEnv 视图分配 id 不重复。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ResearchCache, SEARCH_CACHE_TTL_MS } from "../src/net/cache.ts";
import type { HttpResult } from "../src/net/http.ts";
import { CheckpointStore } from "../src/orchestrator/checkpoint.ts";
import { createMockProvider } from "../src/providers/mock.ts";
import type { ToolEnv } from "../src/tools/env.ts";
import { createEvidenceRecordTool } from "../src/tools/evidence-record.ts";
import { createWebFetchTool } from "../src/tools/web-fetch.ts";
import { createWebSearchTool } from "../src/tools/web-search.ts";
import type { ResearchRun, Task } from "../src/types.ts";

const ARTICLE = "人工智能代理市场规模在2026年预计达到1280亿美元，年增长率为34.5%。".repeat(8);
const HTML = `<html><body><article><p>${ARTICLE}</p></article></body></html>`;

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "pi-research-seq-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function makeTask(id: string): Task {
	return {
		id,
		title: id,
		query: "q",
		rationale: "r",
		criterionIds: [],
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
		query: "q",
		status: "researching",
		createdAt: 0,
		updatedAt: 0,
		schemaVersion: 1,
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

describe("Bug1 修复：seq 跨 taskEnv 视图共享", () => {
	it("两个 taskEnv 视图分配 evidence id 不重复", async () => {
		const run = makeRun();
		const store = await CheckpointStore.create(dir, run.id);
		const sharedEnv: ToolEnv = {
			run,
			store,
			cache: new ResearchCache(dir),
			searchProvider: createMockProvider({
				defaultBehavior: {
					kind: "results",
					results: [
						{ url: "https://example.com/x", title: "t", snippet: ARTICLE.slice(0, 80), rawContent: ARTICLE },
					],
				},
			}),
			fetcher: async (): Promise<HttpResult> => ({
				ok: true,
				status: 200,
				body: HTML,
				finalUrl: "https://example.com/x",
				headers: {},
			}),
			searchCacheTtlMs: SEARCH_CACHE_TTL_MS,
			fresh: false,
			fetchCountByTask: new Map(),
			seq: { source: 1, evidence: 1 },
		};

		// 模拟 executor 的 taskEnv 浅拷贝
		const taskA = makeTask("T1");
		const taskB = makeTask("T2");
		const envA: ToolEnv = { ...sharedEnv, currentTask: taskA };
		const envB: ToolEnv = { ...sharedEnv, currentTask: taskB };

		// Task A：搜索 + 抓取 + 记录
		await createWebSearchTool(envA).execute("a1", { query: "q" });
		await createWebFetchTool(envA).execute("a2", { url: "https://example.com/x" });
		const recordA = createEvidenceRecordTool(envA);
		const rA = await recordA.execute("a3", {
			sourceId: "s1",
			quote: "人工智能代理市场规模在2026年预计达到1280亿美元",
			summary: "A",
			stance: "support",
		});

		// Task B：记录（复用同一 source）
		const recordB = createEvidenceRecordTool(envB);
		const rB = await recordB.execute("b1", {
			sourceId: "s1",
			quote: "年增长率为34.5%",
			summary: "B",
			stance: "support",
		});

		const idA = rA.details?.evidenceId;
		const idB = rB.details?.evidenceId;
		expect(idA).toBeDefined();
		expect(idB).toBeDefined();
		// 关键断言：两个视图分配的 id 不同
		expect(idA).not.toBe(idB);
		// 且全局唯一
		const allIds = run.evidence.map((e) => e.id);
		expect(new Set(allIds).size).toBe(allIds.length);
		// source id 也不重复
		const sourceIds = run.sources.map((s) => s.id);
		expect(new Set(sourceIds).size).toBe(sourceIds.length);
	});

	it("同一 source URL 不重复建 source（跨视图）", async () => {
		const run = makeRun();
		const store = await CheckpointStore.create(dir, run.id);
		const sharedEnv: ToolEnv = {
			run,
			store,
			cache: new ResearchCache(dir),
			searchProvider: createMockProvider({
				defaultBehavior: { kind: "results", results: [{ url: "https://example.com/x", title: "t", snippet: "s" }] },
			}),
			fetcher: async (): Promise<HttpResult> => ({
				ok: true,
				status: 200,
				body: HTML,
				finalUrl: "https://example.com/x",
				headers: {},
			}),
			searchCacheTtlMs: SEARCH_CACHE_TTL_MS,
			fresh: false,
			fetchCountByTask: new Map(),
			seq: { source: 1, evidence: 1 },
		};
		const envA: ToolEnv = { ...sharedEnv, currentTask: makeTask("T1") };
		const envB: ToolEnv = { ...sharedEnv, currentTask: makeTask("T2") };

		await createWebSearchTool(envA).execute("a1", { query: "q" });
		await createWebSearchTool(envB).execute("b1", { query: "q" }); // 同 URL
		expect(run.sources).toHaveLength(1);
	});
});
