/**
 * Mock 搜索 provider（PRD §13.1）。
 *
 * M1~M7 的开发与测试全程使用，不依赖外部网络。
 * 支持两种模式：
 *  - 固定结果集：按 query 精确匹配返回
 *  - 故障脚本：按序注入 timeout / 空结果等故障，用于 failure-policy 测试
 */

import type { SearchProvider, SearchResponse, SearchResultItem } from "./types.ts";

export type MockBehavior =
	| { kind: "results"; results: SearchResultItem[] }
	| {
			kind: "fail";
			failureType: "timeout" | "network" | "rate_limit" | "no_search_result" | "api_error";
			message?: string;
	  };

export interface MockProviderOptions {
	/** query 精确匹配；未命中的 query 走 defaultBehavior */
	table?: Record<string, MockBehavior>;
	defaultBehavior?: MockBehavior;
	/** 故障脚本：每次调用消耗一条，用尽后走 table/default */
	script?: MockBehavior[];
}

const SAMPLE_RESULT: SearchResultItem = {
	url: "https://example.com/sample-report",
	title: "Sample Report",
	snippet: "A sample search result for offline development.",
	rawContent: "Sample report body text used by offline tests.",
	publishedAt: "2026-01-15",
	score: 0.8,
};

export function createMockProvider(options?: MockProviderOptions): SearchProvider {
	const script = [...(options?.script ?? [])];

	return {
		id: "mock",

		async search(input): Promise<SearchResponse> {
			const behavior = script.shift() ??
				options?.table?.[input.query] ??
				options?.defaultBehavior ?? { kind: "results", results: [SAMPLE_RESULT] };

			if (behavior.kind === "fail") {
				return {
					ok: false,
					provider: "mock",
					query: input.query,
					failureType: behavior.failureType,
					message: behavior.message ?? `mock ${behavior.failureType}`,
				};
			}

			if (behavior.results.length === 0) {
				return {
					ok: false,
					provider: "mock",
					query: input.query,
					failureType: "no_search_result",
					message: "0 results",
				};
			}

			return {
				ok: true,
				provider: "mock",
				query: input.query,
				results: behavior.results.slice(0, input.maxResults),
				fromCache: false,
			};
		},
	};
}
