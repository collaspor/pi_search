/**
 * 搜索/抓取缓存（PRD §8.5）。
 *
 *  - 搜索缓存：key = hash(provider + normalizedQuery + maxResults)，默认 TTL 24h；
 *    时效性话题（brief.timeRange.to 指向当前月份）降为 1h
 *  - 抓取缓存：key = canonicalUrl，run 内有效
 *
 * 持久化在 <runDir>/cache/ 下，崩溃 resume 后仍然有效（PRD：重试不烧钱）。
 * 缓存命中的结果保留原始 retrievedAt（§8.5 评审修正：宁可让用户看到
 * "检索于 2 小时前"，也不能把旧数据标成新时间）。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hashArgs } from "../orchestrator/checkpoint.ts";
import type { SearchResultItem } from "../providers/types.ts";

const SEARCH_CACHE_FILE = "search-cache.json";
const FETCH_CACHE_DIR = "fetch-cache";

interface SearchCacheEntry {
	storedAt: number;
	/** 原始 retrievedAt：provider 返回结果的时间，缓存命中不刷新 */
	retrievedAt: number;
	query: string;
	results: SearchResultItem[];
}

interface SearchCacheFile {
	entries: Record<string, SearchCacheEntry>;
}

export const SEARCH_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const SEARCH_CACHE_FRESH_TTL_MS = 60 * 60 * 1000;

export class ResearchCache {
	private readonly runDir: string;
	private searchEntries: Record<string, SearchCacheEntry> | undefined;

	constructor(runDir: string) {
		this.runDir = runDir;
	}

	static searchKey(providerId: string, query: string, maxResults: number): string {
		const normalizedQuery = query.trim().toLowerCase().replace(/\s+/g, " ");
		return hashArgs({ provider: providerId, query: normalizedQuery, maxResults });
	}

	private async loadSearchCache(): Promise<Record<string, SearchCacheEntry>> {
		if (this.searchEntries !== undefined) return this.searchEntries;
		try {
			const text = await readFile(join(this.runDir, "cache", SEARCH_CACHE_FILE), "utf8");
			this.searchEntries = (JSON.parse(text) as SearchCacheFile).entries ?? {};
		} catch {
			this.searchEntries = {};
		}
		return this.searchEntries;
	}

	private async saveSearchCache(): Promise<void> {
		const path = join(this.runDir, "cache", SEARCH_CACHE_FILE);
		await mkdir(join(this.runDir, "cache"), { recursive: true });
		const tmp = `${path}.tmp`;
		const entries = this.searchEntries ?? {};
		await writeFile(tmp, JSON.stringify({ entries } satisfies SearchCacheFile), "utf8");
		await rename(tmp, path);
	}

	async getSearch(key: string, ttlMs: number, now = Date.now()): Promise<SearchCacheEntry | undefined> {
		const entries = await this.loadSearchCache();
		const entry = entries[key];
		if (!entry) return undefined;
		if (now - entry.storedAt > ttlMs) return undefined;
		return entry;
	}

	async setSearch(key: string, query: string, results: SearchResultItem[], now = Date.now()): Promise<void> {
		const entries = await this.loadSearchCache();
		entries[key] = { storedAt: now, retrievedAt: now, query, results };
		await this.saveSearchCache();
	}

	/**
	 * 按规范化 URL 在全部搜索结果里找 rawContent（抓取降级链的一环）。
	 * 扫描所有缓存 entry 的 results，取第一个匹配且 rawContent 非空的。
	 */
	async findRawContentByUrl(canonicalUrl: string, canonicalize: (url: string) => string): Promise<string | undefined> {
		const entries = await this.loadSearchCache();
		for (const entry of Object.values(entries)) {
			for (const item of entry.results) {
				if (item.rawContent && canonicalize(item.url) === canonicalUrl) {
					return item.rawContent;
				}
			}
		}
		return undefined;
	}

	// ── 抓取缓存（run 内有效，无 TTL）─────────────────────────────

	private fetchPath(canonicalUrl: string): string {
		return join(this.runDir, "cache", FETCH_CACHE_DIR, `${hashArgs({ url: canonicalUrl })}.txt`);
	}

	async getFetch(canonicalUrl: string): Promise<string | undefined> {
		try {
			return await readFile(this.fetchPath(canonicalUrl), "utf8");
		} catch {
			return undefined;
		}
	}

	setFetch(canonicalUrl: string, body: string): void {
		const path = this.fetchPath(canonicalUrl);
		mkdirSync(join(this.runDir, "cache", FETCH_CACHE_DIR), { recursive: true });
		writeFileSync(path, body, "utf8");
	}
}

/** 从文件系统同步读搜索缓存（测试辅助） */
export function readSearchCacheSync(runDir: string): SearchCacheFile {
	try {
		return JSON.parse(readFileSync(join(runDir, "cache", SEARCH_CACHE_FILE), "utf8")) as SearchCacheFile;
	} catch {
		return { entries: {} };
	}
}
