/**
 * Tavily 搜索 provider。
 *
 * 凭据仅从环境变量 TAVILY_API_KEY 读取；不落库、不写日志、不进上下文。
 * API 文档：https://docs.tavily.com/api-reference/endpoint/search
 */

import { request } from "undici";
import type { SearchProvider, SearchResponse } from "./types.ts";

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const DEFAULT_TIMEOUT_MS = 15_000;

interface TavilyResultItem {
	url?: string;
	title?: string;
	content?: string;
	raw_content?: string;
	published_date?: string;
	score?: number;
}

interface TavilyResponseBody {
	results?: TavilyResultItem[];
}

export function createTavilyProvider(options?: { timeoutMs?: number }): SearchProvider {
	const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	return {
		id: "tavily",

		async search(input): Promise<SearchResponse> {
			const apiKey = process.env.TAVILY_API_KEY;
			if (!apiKey) {
				return {
					ok: false,
					provider: "tavily",
					query: input.query,
					failureType: "api_error",
					message: "TAVILY_API_KEY is not set",
				};
			}

			const maxResults = Math.max(1, Math.min(input.maxResults, 10));
			const body = JSON.stringify({
				query: input.query,
				max_results: maxResults,
				search_depth: "advanced",
				include_raw_content: true,
				topic: "general",
				...(input.timeRange ? { time_range: input.timeRange } : {}),
			});

			const timeout = AbortSignal.timeout(timeoutMs);
			const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;

			let status: number;
			let text: string;
			try {
				const response = await request(TAVILY_SEARCH_URL, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						authorization: `Bearer ${apiKey}`,
					},
					body,
					headersTimeout: timeoutMs,
					bodyTimeout: timeoutMs,
					signal,
				});
				status = response.statusCode;
				text = await response.body.text();
			} catch (err) {
				if (input.signal?.aborted) {
					return { ok: false, provider: "tavily", query: input.query, failureType: "timeout", message: "aborted" };
				}
				const message = err instanceof Error ? err.message : String(err);
				const isTimeout = /timeout|timed?\s*out|ETIMEDOUT|aborted/i.test(message);
				return {
					ok: false,
					provider: "tavily",
					query: input.query,
					failureType: isTimeout ? "timeout" : "network",
					message,
				};
			}

			if (status === 429) {
				return {
					ok: false,
					provider: "tavily",
					query: input.query,
					failureType: "rate_limit",
					message: "HTTP 429",
				};
			}
			if (status < 200 || status >= 300) {
				return {
					ok: false,
					provider: "tavily",
					query: input.query,
					failureType: "api_error",
					// 不记录响应体，避免回显可能含敏感信息的错误详情
					message: `HTTP ${status}`,
				};
			}

			let parsed: TavilyResponseBody;
			try {
				parsed = JSON.parse(text) as TavilyResponseBody;
			} catch {
				return {
					ok: false,
					provider: "tavily",
					query: input.query,
					failureType: "api_error",
					message: "invalid JSON response",
				};
			}

			const results = (parsed.results ?? [])
				.filter(
					(item): item is TavilyResultItem & { url: string } => typeof item.url === "string" && item.url !== "",
				)
				.map((item) => ({
					url: item.url,
					title: item.title ?? "",
					snippet: item.content ?? "",
					rawContent: item.raw_content || undefined,
					publishedAt: item.published_date || undefined,
					score: typeof item.score === "number" ? item.score : undefined,
				}));

			if (results.length === 0) {
				return {
					ok: false,
					provider: "tavily",
					query: input.query,
					failureType: "no_search_result",
					message: "0 results",
				};
			}

			return { ok: true, provider: "tavily", query: input.query, results, fromCache: false };
		},
	};
}
