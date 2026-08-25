/**
 * 工具共享环境（ToolEnv）。
 *
 * 工具与研究逻辑零耦合：工具只拿数据/存数据，状态全部经 ToolEnv 注入。
 * Executor 执行每个 Task 前设置 currentTaskId，工具据此归属 evidence。
 * fetcher 与 searchProvider 可注入替身，测试时不触网。
 */

import type { ResearchCache } from "../net/cache.ts";
import type { FetchWithRetryOptions, HttpResult } from "../net/http.ts";
import type { CheckpointStore } from "../orchestrator/checkpoint.ts";
import type { FailureTracker } from "../orchestrator/failure-policy.ts";
import type { SearchProvider } from "../providers/types.ts";
import type { ResearchRun, SourceTier, Task } from "../types.ts";

export type Fetcher = (url: string, options: FetchWithRetryOptions) => Promise<HttpResult>;

export interface ToolEnv {
	run: ResearchRun;
	store: CheckpointStore;
	cache: ResearchCache;
	searchProvider: SearchProvider;
	fetcher: Fetcher;
	/** 当前正在执行的 Task（由 Executor 设置） */
	currentTask?: Task;
	/** 搜索缓存 TTL（时效性话题降为 1h） */
	searchCacheTtlMs: number;
	/** --research-fresh：跳过全部缓存 */
	fresh: boolean;
	/** 每个 Task 的 fetch 次数计数（Budget.maxFetchPerTask） */
	fetchCountByTask: Map<string, number>;
	/**
	 * source / evidence 序号分配器（引用类型，跨 taskEnv 视图共享）。
	 * 浅拷贝 {...env} 会复制 number 原始值导致各 Task id 重复（真实 bug），
	 * 必须用对象引用保证全局唯一单调递增。
	 */
	seq: { source: number; evidence: number };
	/** 失败策略追踪器（M6）：搜索改写/抓取失败/quote 拒收的硬计数 */
	failureTracker?: FailureTracker;
	/** 当前 Task 的取消信号（M6：搜索/抓取可被取消） */
	signal?: AbortSignal;
}

/** URL 规范化：去 utm_* 参数、去 fragment、去尾斜杠，用于去重与缓存键 */
export function canonicalizeUrl(rawUrl: string): string {
	try {
		const url = new URL(rawUrl);
		for (const key of [...url.searchParams.keys()]) {
			if (key.startsWith("utm_") || key === "gclid" || key === "fbclid") {
				url.searchParams.delete(key);
			}
		}
		url.hash = "";
		let str = url.toString();
		if (str.endsWith("/") && url.pathname === "/") {
			str = str.slice(0, -1);
		}
		return str;
	} catch {
		return rawUrl;
	}
}

const TIER1_SUFFIXES = [".gov", ".gov.cn", ".edu", ".mil"];
const TIER1_DOMAINS = new Set([
	"openai.com",
	"anthropic.com",
	"google.com",
	"deepmind.google",
	"blog.google",
	"microsoft.com",
	"apple.com",
	"developer.android.com",
]);
const TIER2_DOMAINS = new Set([
	"reuters.com",
	"bloomberg.com",
	"ft.com",
	"wsj.com",
	"nytimes.com",
	"bbc.com",
	"bbc.co.uk",
	"economist.com",
	"caixin.com",
	"people.com.cn",
	"xinhuanet.com",
]);
const TIER3_DOMAINS = new Set([
	"techcrunch.com",
	"theverge.com",
	"wired.com",
	"arstechnica.com",
	"36kr.com",
	"infoq.cn",
	"venturebeat.com",
	"zdnet.com",
	"gartner.com",
	"mckinsey.com",
	"statista.com",
]);

/** 域名 → 信源分级（PRD §8.4 多级过滤漏斗的低成本实现） */
export function classifyTier(url: string): SourceTier {
	let host: string;
	try {
		host = new URL(url).hostname.toLowerCase();
	} catch {
		return 4;
	}
	for (const suffix of TIER1_SUFFIXES) {
		if (host.endsWith(suffix)) return 1;
	}
	for (const domain of TIER1_DOMAINS) {
		if (host === domain || host.endsWith(`.${domain}`)) return 1;
	}
	for (const domain of TIER2_DOMAINS) {
		if (host === domain || host.endsWith(`.${domain}`)) return 2;
	}
	for (const domain of TIER3_DOMAINS) {
		if (host === domain || host.endsWith(`.${domain}`)) return 3;
	}
	return 4;
}
