/**
 * 工具层测试（A3/A4）：web_search、web_fetch、evidence_record、evidence_query。
 * searchProvider 与 fetcher 全部注入桩，不触网。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ResearchCache, SEARCH_CACHE_TTL_MS } from "../src/net/cache.ts";
import type { HttpResult } from "../src/net/http.ts";
import { CheckpointStore } from "../src/orchestrator/checkpoint.ts";
import { createMockProvider } from "../src/providers/mock.ts";
import { canonicalizeUrl, classifyTier, type ToolEnv } from "../src/tools/env.ts";
import { createEvidenceQueryTool } from "../src/tools/evidence-query.ts";
import { createEvidenceRecordTool } from "../src/tools/evidence-record.ts";
import { createWebFetchTool } from "../src/tools/web-fetch.ts";
import { createWebSearchTool } from "../src/tools/web-search.ts";
import type { ResearchRun, Task } from "../src/types.ts";

const ARTICLE =
	"人工智能代理市场规模在2026年预计达到1280亿美元，年增长率为34.5%。根据Gartner报告，企业级采购是核心驱动力。".repeat(
		8,
	);
const HTML_PAGE = `<html><head><title>市场报告</title></head><body><article><p>${ARTICLE}</p></article></body></html>`;

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "pi-research-tools-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function makeTask(id = "T1"): Task {
	return {
		id,
		title: "市场规模",
		query: "AI agent market 2026",
		rationale: "r",
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
			maxFetchPerTask: 3,
			usedTokens: 0,
			usedCostUsd: 0,
			startedAt: 0,
		},
		recoveries: [],
		lastSeq: 0,
	};
}

interface EnvSetup {
	env: ToolEnv;
	task: Task;
	fetchCalls: string[];
}

async function setupEnv(options?: {
	searchResults?: { url: string; title: string; snippet: string; rawContent?: string; publishedAt?: string }[];
	fetchResult?: HttpResult;
	searchBehavior?: "ok" | "empty" | "timeout";
}): Promise<EnvSetup> {
	const run = makeRun();
	const store = await CheckpointStore.create(dir, run.id);
	const task = makeTask();
	run.plan = { tasks: [task], replanCount: 0 };

	const searchResults = options?.searchResults ?? [
		{
			url: "https://example.com/report",
			title: "2026 市场报告",
			snippet: "人工智能代理市场规模在2026年预计达到1280亿美元。",
			rawContent: ARTICLE,
			publishedAt: "2026-03-15",
		},
	];

	const provider =
		options?.searchBehavior === "empty"
			? createMockProvider({ defaultBehavior: { kind: "results", results: [] } })
			: options?.searchBehavior === "timeout"
				? createMockProvider({ defaultBehavior: { kind: "fail", failureType: "timeout" } })
				: createMockProvider({ defaultBehavior: { kind: "results", results: searchResults } });

	const fetchCalls: string[] = [];
	const fetchResult: HttpResult =
		options?.fetchResult ??
		({ ok: true, status: 200, body: HTML_PAGE, finalUrl: "https://example.com/report", headers: {} } as HttpResult);

	const env: ToolEnv = {
		run,
		store,
		cache: new ResearchCache(dir),
		searchProvider: provider,
		fetcher: async (url) => {
			fetchCalls.push(url);
			return fetchResult;
		},
		currentTask: task,
		searchCacheTtlMs: SEARCH_CACHE_TTL_MS,
		fresh: false,
		fetchCountByTask: new Map(),
		seq: { source: 1, evidence: 1 },
	};
	return { env, task, fetchCalls };
}

describe("web_search（A3）", () => {
	it("搜索结果注册为 snippet 级 Source，content/details 分离", async () => {
		const { env } = await setupEnv();
		const tool = createWebSearchTool(env);
		const r = await tool.execute("c1", { query: "AI agent market" });

		expect(r.details?.ok).toBe(true);
		expect(r.details?.resultCount).toBe(1);
		expect(env.run.sources).toHaveLength(1);
		expect(env.run.sources[0].fetchStrategy).toBe("snippet");
		expect(env.run.sources[0].tier).toBe(4);
		// content 是精简文本，details 有完整结构
		expect(r.content[0].type).toBe("text");
		expect(r.details?.results[0].rawContent).toBe(ARTICLE);
		// 事件落盘
		const source = env.run.sources[0];
		expect(await env.store.readSourceBody(source.id)).toContain("1280亿美元");
	});

	it("空结果返回改写提示且记 no_search_result", async () => {
		const { env } = await setupEnv({ searchBehavior: "empty" });
		const tool = createWebSearchTool(env);
		const r = await tool.execute("c1", { query: "xyz" });
		expect(r.details?.ok).toBe(false);
		expect(r.details?.failureType).toBe("no_search_result");
		expect(r.content[0].type === "text" && r.content[0].text).toContain("rewriting");
	});

	it("超时返回失败且不重试（重试是 M6 的事）", async () => {
		const { env } = await setupEnv({ searchBehavior: "timeout" });
		const tool = createWebSearchTool(env);
		const r = await tool.execute("c1", { query: "q" });
		expect(r.details?.failureType).toBe("timeout");
	});

	it("第二次同 query 命中缓存，不再调 provider", async () => {
		const { env } = await setupEnv();
		const tool = createWebSearchTool(env);
		await tool.execute("c1", { query: "AI agent market" });
		const r2 = await tool.execute("c2", { query: "AI agent market" });
		expect(r2.details?.fromCache).toBe(true);
		// 同一 URL 不重复建 Source
		expect(env.run.sources).toHaveLength(1);
	});
});

describe("web_fetch（A3/A8）", () => {
	it("抓取后提取正文并升级 Source，正文被 untrusted 包裹", async () => {
		const { env, fetchCalls } = await setupEnv();
		const search = createWebSearchTool(env);
		await search.execute("c1", { query: "q" });

		const fetch = createWebFetchTool(env);
		const r = await fetch.execute("c2", { url: "https://example.com/report" });

		expect(r.details?.ok).toBe(true);
		expect(fetchCalls).toHaveLength(1);
		const source = env.run.sources[0];
		expect(source.fetchStrategy).toBe("readability");
		expect(source.charCount).toBeGreaterThan(200);
		const text = r.content[0].type === "text" ? r.content[0].text : "";
		expect(text).toContain("<untrusted-content");
		expect(text).toContain("</untrusted-content>");
	});

	it("分段读取：offset 续读", async () => {
		const { env } = await setupEnv();
		const fetch = createWebFetchTool(env);
		const r1 = await fetch.execute("c1", { url: "https://example.com/report", limit: 500 });
		expect(r1.details?.truncated).toBe(true);
		const r2 = await fetch.execute("c2", { url: "https://example.com/report", offset: 500, limit: 500 });
		expect(r2.details?.ok).toBe(true);
		const t1 = r1.content[0].type === "text" ? r1.content[0].text : "";
		const t2 = r2.content[0].type === "text" ? r2.content[0].text : "";
		expect(t1).not.toBe(t2);
	});

	it("抓取失败且有 rawContent 时优先降级到 raw_content（修复后行为）", async () => {
		const { env } = await setupEnv({
			fetchResult: { ok: false, failureType: "http_4xx", status: 403, message: "HTTP 403" },
		});
		const search = createWebSearchTool(env);
		await search.execute("c1", { query: "q" });

		const fetch = createWebFetchTool(env);
		const r = await fetch.execute("c2", { url: "https://example.com/report" });
		expect(r.details?.ok).toBe(true);
		// 修复后：默认数据带 rawContent，降级链优先用 raw_content 而非 snippet
		expect(r.details?.fetchStrategy).toBe("raw_content");
		const text = r.content[0].type === "text" ? r.content[0].text : "";
		expect(text).toContain("fallback");
	});

	it("超过 maxFetchPerTask 拒绝继续抓取", async () => {
		const { env, task } = await setupEnv();
		const fetch = createWebFetchTool(env);
		await fetch.execute("c1", { url: "https://example.com/report" });
		// 换不同 URL 避免缓存
		await fetch.execute("c2", { url: "https://example.com/other1" });
		await fetch.execute("c3", { url: "https://example.com/other2" });
		const r4 = await fetch.execute("c4", { url: "https://example.com/other3" });
		expect(r4.details?.ok).toBe(false);
		expect(r4.content[0].type === "text" && r4.content[0].text).toContain("budget");
		expect(task).toBeDefined();
	});

	it("抓取失败时优先用搜索缓存的 raw_content 降级（修复验证）", async () => {
		// fetch 返回 403，但搜索结果带完整 rawContent
		const { env } = await setupEnv({
			fetchResult: { ok: false, failureType: "http_4xx", status: 403, message: "HTTP 403" },
		});
		// 先搜索：rawContent 进搜索缓存
		await createWebSearchTool(env).execute("c1", { query: "q" });

		const fetch = createWebFetchTool(env);
		const r = await fetch.execute("c2", { url: "https://example.com/report" });

		// 降级到 raw_content 而非 snippet：正文完整、策略标记正确
		expect(r.details?.ok).toBe(true);
		expect(r.details?.fetchStrategy).toBe("raw_content");
		const source = env.run.sources[0];
		expect(source.fetchStrategy).toBe("raw_content");
		expect(source.charCount).toBe(ARTICLE.length);
		const text = r.content[0].type === "text" ? r.content[0].text : "";
		expect(text).toContain("raw_content");
		expect(text).toContain("人工智能代理市场");
	});

	it("无 raw_content 时降级链落到 snippet", async () => {
		const { env } = await setupEnv({
			searchResults: [{ url: "https://example.com/report", title: "t", snippet: "只有摘要没有正文。" }],
			fetchResult: { ok: false, failureType: "http_4xx", status: 403, message: "HTTP 403" },
		});
		await createWebSearchTool(env).execute("c1", { query: "q" });

		const fetch = createWebFetchTool(env);
		const r = await fetch.execute("c2", { url: "https://example.com/report" });
		expect(r.details?.ok).toBe(true);
		expect(r.details?.fetchStrategy).toBe("snippet");
	});
});

describe("evidence_record（A4）", () => {
	it("quote 逐字命中 → 落库 + evidenceCount 增加", async () => {
		const { env, task } = await setupEnv();
		await createWebSearchTool(env).execute("c1", { query: "q" });
		await createWebFetchTool(env).execute("c2", { url: "https://example.com/report" });

		const record = createEvidenceRecordTool(env);
		const r = await record.execute("c3", {
			sourceId: "s1",
			quote: "人工智能代理市场规模在2026年预计达到1280亿美元",
			summary: "市场规模量化数据",
			stance: "support",
		});

		expect(r.details?.ok).toBe(true);
		expect(task.evidenceCount).toBe(1);
		expect(env.run.evidence).toHaveLength(1);
		expect(env.run.evidence[0].quoteMatch).toBe("exact");
		expect(env.run.evidence[0].taskId).toBe("T1");
	});

	it("quote 不存在 → 拒收且不计数", async () => {
		const { env, task } = await setupEnv();
		await createWebSearchTool(env).execute("c1", { query: "q" });
		await createWebFetchTool(env).execute("c2", { url: "https://example.com/report" });

		const record = createEvidenceRecordTool(env);
		const r = await record.execute("c3", {
			sourceId: "s1",
			quote: "这段话在原文里完全不存在也不可能被模糊匹配到",
			summary: "x",
			stance: "neutral",
		});

		expect(r.details?.ok).toBe(false);
		expect(task.evidenceCount).toBe(0);
		expect(env.run.evidence).toHaveLength(0);
	});

	it("数字被篡改的 quote 拒收", async () => {
		const { env } = await setupEnv();
		await createWebSearchTool(env).execute("c1", { query: "q" });
		await createWebFetchTool(env).execute("c2", { url: "https://example.com/report" });

		const record = createEvidenceRecordTool(env);
		const r = await record.execute("c3", {
			sourceId: "s1",
			quote: "人工智能代理市场规模在2026年预计达到9280亿美元，年增长率为34.5%。根据Gartner报告，企业级采购是核心驱动力。",
			summary: "篡改数字",
			stance: "support",
		});
		expect(r.details?.ok).toBe(false);
	});

	it("未知 sourceId 拒收", async () => {
		const { env } = await setupEnv();
		const record = createEvidenceRecordTool(env);
		const r = await record.execute("c1", { sourceId: "s999", quote: "q", summary: "s", stance: "neutral" });
		expect(r.details?.ok).toBe(false);
		expect(r.content[0].type === "text" && r.content[0].text).toContain("unknown sourceId");
	});
});

describe("evidence_query", () => {
	it("按关键词检索并排序", async () => {
		const { env } = await setupEnv();
		await createWebSearchTool(env).execute("c1", { query: "q" });
		await createWebFetchTool(env).execute("c2", { url: "https://example.com/report" });
		const record = createEvidenceRecordTool(env);
		await record.execute("c3", {
			sourceId: "s1",
			quote: "人工智能代理市场规模在2026年预计达到1280亿美元",
			summary: "市场规模",
			stance: "support",
		});

		const query = createEvidenceQueryTool(env);
		const r = await query.execute("c4", { keywords: ["市场规模", "1280"] });
		expect(r.details?.ok).toBe(true);
		expect(r.details?.matchCount).toBe(1);
		expect(r.details?.evidenceIds[0]).toBe("e1");
	});

	it("无匹配返回提示", async () => {
		const { env } = await setupEnv();
		const query = createEvidenceQueryTool(env);
		const r = await query.execute("c1", { keywords: ["完全不相关的词xyz"] });
		expect(r.details?.matchCount).toBe(0);
	});
});

describe("env 工具函数", () => {
	it("canonicalizeUrl 去 utm 与 fragment", () => {
		expect(canonicalizeUrl("https://example.com/p?utm_source=x&id=1#sec")).toBe("https://example.com/p?id=1");
	});
	it("classifyTier 分级", () => {
		expect(classifyTier("https://openai.com/blog/x")).toBe(1);
		expect(classifyTier("https://www.gov.cn/z/x")).toBe(1);
		expect(classifyTier("https://reuters.com/world/x")).toBe(2);
		expect(classifyTier("https://techcrunch.com/x")).toBe(3);
		expect(classifyTier("https://random-blog.io/x")).toBe(4);
	});
});
