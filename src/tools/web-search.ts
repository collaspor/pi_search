/**
 * web_search 工具（PRD §5.1，验收 A3）。
 *
 * 行为：查缓存 → 调 SearchProvider → 结果注册为 Source（snippet 级，
 * 待 web_fetch 升级）→ content 给模型精简列表，details 存完整结构。
 * 利用 pi AgentToolResult 的 content/details 分离：模型只看省 token 的
 * 摘要，完整数据（含 raw_content）落库作抓取降级链的原料。
 */

import { createHash } from "node:crypto";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { ResearchCache } from "../net/cache.ts";
import type { SearchResultItem } from "../providers/types.ts";
import type { FailureType, Source } from "../types.ts";
import { canonicalizeUrl, classifyTier, type ToolEnv } from "./env.ts";

interface SearchDetails {
	ok: boolean;
	failureType?: FailureType;
	message?: string;
	fromCache: boolean;
	resultCount: number;
	/** 完整结构化结果（含 raw_content），供抓取降级链使用 */
	results: SearchResultItem[];
	sourceIds: string[];
}

function contentHash(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** 把搜索结果注册为 Source（snippet 级）。已存在同 canonicalUrl 的复用。 */
export async function registerSourcesFromResults(env: ToolEnv, results: SearchResultItem[]): Promise<string[]> {
	const sourceIds: string[] = [];
	for (const item of results) {
		const canonicalUrl = canonicalizeUrl(item.url);
		const existing = env.run.sources.find((s) => s.canonicalUrl === canonicalUrl);
		if (existing) {
			sourceIds.push(existing.id);
			continue;
		}
		const id = `s${env.seq.source++}`;
		const body = item.snippet;
		const source: Source = {
			id,
			url: item.url,
			canonicalUrl,
			title: item.title,
			domain: safeDomain(item.url),
			publishedAt: item.publishedAt,
			retrievedAt: Date.now(),
			tier: classifyTier(item.url),
			fetchStrategy: "snippet",
			contentHash: contentHash(body),
			charCount: body.length,
			bodyRef: `sources/${id}.txt`,
		};
		await env.store.writeSourceBody(id, body);
		env.run.sources.push(source);
		await env.store.appendEvent({ type: "source_added", source });
		sourceIds.push(id);
	}
	return sourceIds;
}

function safeDomain(url: string): string {
	try {
		return new URL(url).hostname;
	} catch {
		return "";
	}
}

function formatForModel(results: SearchResultItem[], sourceIds: string[], fromCache: boolean): string {
	const lines = results.map((r, i) => {
		const date = r.publishedAt ? ` (${r.publishedAt})` : "";
		return `[${sourceIds[i]}] ${r.title}${date}\n    ${r.url}\n    ${r.snippet.slice(0, 300)}`;
	});
	return `Found ${results.length} results${fromCache ? " (from cache)" : ""}:\n\n${lines.join("\n\n")}`;
}

const SearchParams = Type.Object({
	query: Type.String({ description: "Search query" }),
	maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Max results, default 5" })),
	timeRange: Type.Optional(
		Type.Union([Type.Literal("day"), Type.Literal("week"), Type.Literal("month"), Type.Literal("year")], {
			description: "Limit to recent results",
		}),
	),
});

export function createWebSearchTool(env: ToolEnv): AgentTool<typeof SearchParams, SearchDetails> {
	return {
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web for information. Returns a list of results with source ids (s1, s2, ...), titles, urls and snippets. Use web_fetch on the most promising results to get full page content.",
		parameters: SearchParams,

		async execute(_toolCallId, params): Promise<AgentToolResult<SearchDetails>> {
			const startedAt = Date.now();
			const query = String(params.query ?? "");
			const maxResults = typeof params.maxResults === "number" ? params.maxResults : 5;
			const timeRange =
				typeof params.timeRange === "string" ? (params.timeRange as "day" | "week" | "month" | "year") : undefined;
			const taskId = env.currentTask?.id ?? "";

			const finish = async (details: SearchDetails, text: string, isError = false) => {
				await env.store.appendEvent({
					type: "tool_call",
					taskId,
					tool: "web_search",
					argsHash: ResearchCache.searchKey(env.searchProvider.id, query, maxResults),
					latencyMs: Date.now() - startedAt,
					ok: details.ok,
					failureType: details.failureType,
				});
				return { content: [{ type: "text" as const, text }], details, isError };
			};

			// 缓存
			const cacheKey = ResearchCache.searchKey(env.searchProvider.id, query, maxResults);
			if (!env.fresh) {
				const cached = await env.cache.getSearch(cacheKey, env.searchCacheTtlMs);
				if (cached) {
					const results = cached.results.slice(0, maxResults);
					const sourceIds = await registerSourcesFromResults(env, results);
					const details: SearchDetails = {
						ok: true,
						fromCache: true,
						resultCount: results.length,
						results,
						sourceIds,
					};
					return finish(details, formatForModel(results, sourceIds, true));
				}
			}

			// 调 provider
			const response = await env.searchProvider.search({ query, maxResults, timeRange });
			if (!response.ok) {
				const failureType = response.failureType as FailureType;
				const details: SearchDetails = {
					ok: false,
					failureType,
					message: response.message,
					fromCache: false,
					resultCount: 0,
					results: [],
					sourceIds: [],
				};
				const text =
					failureType === "no_search_result"
						? `Search returned 0 results for "${query}". Try rewriting the query (different keywords, language, or broader scope).`
						: `Search failed (${failureType}): ${response.message}`;
				return finish(details, text, true);
			}

			const results = response.results;
			if (!env.fresh) await env.cache.setSearch(cacheKey, query, results);
			const sourceIds = await registerSourcesFromResults(env, results);
			const details: SearchDetails = { ok: true, fromCache: false, resultCount: results.length, results, sourceIds };
			return finish(details, formatForModel(results, sourceIds, false));
		},
	};
}
