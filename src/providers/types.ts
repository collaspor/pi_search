/**
 * SearchProvider 接口（PRD §2）。
 *
 * 搜索是本系统的唯一数据入口，接口抽象使服务商可替换：
 *  - tavily.ts：真实服务（M8 联调）
 *  - mock.ts：离线开发与测试（M1~M7）
 */

export interface SearchResultItem {
	url: string;
	title: string;
	/** 搜索引擎返回的摘要片段 */
	snippet: string;
	/** provider 额外返回的清洗正文（Tavily raw_content），可作抓取降级链一环 */
	rawContent?: string;
	publishedAt?: string;
	/** provider 相关性打分，0~1，可选 */
	score?: number;
}

export interface SearchOk {
	ok: true;
	provider: string;
	query: string;
	results: SearchResultItem[];
	/** 是否来自缓存（由上层 cache.ts 标记，provider 自身恒为 false） */
	fromCache: boolean;
}

export interface SearchFail {
	ok: false;
	provider: string;
	query: string;
	failureType: "timeout" | "network" | "rate_limit" | "no_search_result" | "api_error";
	message: string;
}

export type SearchResponse = SearchOk | SearchFail;

export interface SearchQuery {
	query: string;
	maxResults: number; // 1~10
	timeRange?: "day" | "week" | "month" | "year";
	signal?: AbortSignal;
}

export interface SearchProvider {
	readonly id: string;
	search(input: SearchQuery): Promise<SearchResponse>;
}
