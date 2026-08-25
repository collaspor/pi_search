/**
 * web_fetch 工具（PRD §5.2，验收 A3/A8）。
 *
 * 行为链：SSRF（http.ts 内部 + onBlocked 记事件）→ 抓取缓存 → 重试抓取
 * → 正文提取降级链（readability → plaintext → raw_content → snippet）
 * → 正文落盘 + Source 升级 → 模型拿到 <untrusted-content> 包裹的分段正文。
 */

import { createHash } from "node:crypto";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { extractBody, MIN_BODY_CHARS } from "../net/extract.ts";
import { defaultFetchOptions } from "../net/http.ts";
import { wrapUntrustedContent } from "../net/untrusted.ts";
import { hashArgs } from "../orchestrator/checkpoint.ts";
import type { FailureType, Source } from "../types.ts";
import { canonicalizeUrl, type ToolEnv } from "./env.ts";
import { registerSourcesFromResults } from "./web-search.ts";

const DEFAULT_PAGE_CHARS = 6000;

interface FetchDetails {
	ok: boolean;
	failureType?: FailureType;
	message?: string;
	sourceId?: string;
	fetchStrategy?: Source["fetchStrategy"];
	charCount?: number;
	truncated: boolean;
	fromCache: boolean;
}

function contentHash(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function pageSlice(body: string, offset: number, limit: number): { text: string; truncated: boolean } {
	if (offset >= body.length) return { text: "", truncated: false };
	const slice = body.slice(offset, offset + limit);
	return { text: slice, truncated: offset + limit < body.length };
}

const FetchParams = Type.Object({
	url: Type.String({ description: "Absolute http(s) URL" }),
	offset: Type.Optional(Type.Integer({ minimum: 0, description: "Character offset to continue reading, default 0" })),
	limit: Type.Optional(
		Type.Integer({ minimum: 500, maximum: 20000, description: "Segment size in chars, default 6000" }),
	),
});

export function createWebFetchTool(env: ToolEnv): AgentTool<typeof FetchParams, FetchDetails> {
	return {
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch a web page and return its main content (wrapped in <untrusted-content> tags as external data). Long pages are returned in segments; use offset to continue reading.",
		parameters: FetchParams,

		async execute(_toolCallId, params): Promise<AgentToolResult<FetchDetails>> {
			const startedAt = Date.now();
			const url = String(params.url ?? "");
			const offset = typeof params.offset === "number" ? params.offset : 0;
			const limit = typeof params.limit === "number" ? params.limit : DEFAULT_PAGE_CHARS;
			const taskId = env.currentTask?.id ?? "";

			const finish = async (details: FetchDetails, text: string, isError = false) => {
				await env.store.appendEvent({
					type: "tool_call",
					taskId,
					tool: "web_fetch",
					argsHash: hashArgs({ tool: "web_fetch", url: canonicalizeUrl(url), offset }),
					latencyMs: Date.now() - startedAt,
					ok: details.ok,
					failureType: details.failureType,
				});
				return { content: [{ type: "text" as const, text }], details, isError };
			};

			// fetch 次数上限（Budget.maxFetchPerTask）
			const fetchCount = env.fetchCountByTask.get(taskId) ?? 0;
			if (fetchCount >= env.run.budget.maxFetchPerTask) {
				return finish(
					{
						ok: false,
						failureType: "task_exception",
						message: "fetch budget per task exceeded",
						truncated: false,
						fromCache: false,
					},
					`Fetch budget for this task is exhausted (${env.run.budget.maxFetchPerTask} fetches). Work with the search snippets you already have.`,
					true,
				);
			}

			const canonicalUrl = canonicalizeUrl(url);

			// 已有完整 Source（之前抓过）
			const existing = env.run.sources.find((s) => s.canonicalUrl === canonicalUrl && s.fetchStrategy !== "snippet");
			if (existing && !env.fresh) {
				const body = await env.store.readSourceBody(existing.id);
				if (body !== undefined) {
					const { text, truncated } = pageSlice(body, offset, limit);
					return finish(
						{
							ok: true,
							sourceId: existing.id,
							fetchStrategy: existing.fetchStrategy,
							charCount: body.length,
							truncated,
							fromCache: true,
						},
						wrapUntrustedContent(existing.id, url, text) +
							(truncated ? `\n\n[truncated: use offset=${offset + limit} to continue]` : ""),
					);
				}
			}

			// 抓取缓存（run 内）
			if (!env.fresh) {
				const cachedBody = await env.cache.getFetch(canonicalUrl);
				if (cachedBody !== undefined) {
					const sourceId = await upgradeSource(env, url, cachedBody, "readability");
					const { text, truncated } = pageSlice(cachedBody, offset, limit);
					return finish(
						{
							ok: true,
							sourceId,
							fetchStrategy: "readability",
							charCount: cachedBody.length,
							truncated,
							fromCache: true,
						},
						wrapUntrustedContent(sourceId, url, text) +
							(truncated ? `\n\n[truncated: use offset=${offset + limit} to continue]` : ""),
					);
				}
			}

			// 真实抓取
			env.fetchCountByTask.set(taskId, fetchCount + 1);
			const result = await env.fetcher(url, {
				...defaultFetchOptions(),
				onBlocked: (blockedUrl, reason) => {
					void env.store.appendEvent({ type: "blocked_url", url: blockedUrl, reason });
				},
			});

			if (!result.ok) {
				// 降级：搜索缓存里的 raw_content / snippet
				const degraded = await degradeFromSearchData(env, url, canonicalUrl);
				if (degraded) {
					const { text, truncated } = pageSlice(degraded.body, offset, limit);
					return finish(
						{
							ok: true,
							sourceId: degraded.sourceId,
							fetchStrategy: degraded.strategy,
							charCount: degraded.body.length,
							truncated,
							fromCache: true,
						},
						`[Fetch failed (${result.failureType}); using ${degraded.strategy} fallback]\n${wrapUntrustedContent(degraded.sourceId, url, text)}`,
					);
				}
				// M6：真正失败（降级也失败）→ 累计并给扩量/收尾指引
				const hint = env.failureTracker?.onFetchFailure(taskId).hint;
				return finish(
					{
						ok: false,
						failureType: result.failureType,
						message: result.message,
						truncated: false,
						fromCache: false,
					},
					`Fetch failed (${result.failureType}): ${result.message}${hint ? `\n${hint}` : ""}`,
					true,
				);
			}

			// 提取正文（readability → plaintext）
			const extracted = extractBody(result.body, result.finalUrl);
			if (!extracted || extracted.text.length < MIN_BODY_CHARS) {
				const degraded = await degradeFromSearchData(env, url, canonicalUrl);
				if (degraded) {
					const { text, truncated } = pageSlice(degraded.body, offset, limit);
					return finish(
						{
							ok: true,
							sourceId: degraded.sourceId,
							fetchStrategy: degraded.strategy,
							charCount: degraded.body.length,
							truncated,
							fromCache: true,
						},
						`[Page content extraction failed; using ${degraded.strategy} fallback]\n${wrapUntrustedContent(degraded.sourceId, url, text)}`,
					);
				}
				return finish(
					{
						ok: false,
						failureType: "parse_error",
						message: "content extraction produced too little text",
						truncated: false,
						fromCache: false,
					},
					"Fetch succeeded but no usable article text could be extracted from this page. Try a different source.",
					true,
				);
			}

			await env.cache.setFetch(canonicalUrl, extracted.text);
			const sourceId = await upgradeSource(
				env,
				result.finalUrl,
				extracted.text,
				extracted.strategy,
				extracted.title,
			);
			const { text, truncated } = pageSlice(extracted.text, offset, limit);
			return finish(
				{
					ok: true,
					sourceId,
					fetchStrategy: extracted.strategy,
					charCount: extracted.text.length,
					truncated,
					fromCache: false,
				},
				wrapUntrustedContent(sourceId, url, text) +
					(truncated ? `\n\n[truncated: use offset=${offset + limit} to continue]` : ""),
			);
		},
	};
}

/** 创建或升级 Source（snippet 级 → 完整正文级），返回 sourceId */
async function upgradeSource(
	env: ToolEnv,
	url: string,
	body: string,
	strategy: Source["fetchStrategy"],
	title?: string,
): Promise<string> {
	const canonicalUrl = canonicalizeUrl(url);
	const existing = env.run.sources.find((s) => s.canonicalUrl === canonicalUrl);
	if (existing) {
		existing.fetchStrategy = strategy;
		existing.charCount = body.length;
		existing.contentHash = contentHash(body);
		if (title && !existing.title) existing.title = title;
		await env.store.writeSourceBody(existing.id, body);
		await env.store.appendEvent({ type: "source_added", source: existing });
		return existing.id;
	}
	const ids = await registerSourcesFromResults(env, [{ url, title: title ?? "", snippet: body }]);
	return ids[0];
}

/** 抓取失败时的降级链：raw_content → snippet（PRD §8.2 抓取降级链后两级） */
async function degradeFromSearchData(
	env: ToolEnv,
	url: string,
	canonicalUrl: string,
): Promise<{ sourceId: string; body: string; strategy: Source["fetchStrategy"] } | undefined> {
	// 优先：搜索缓存里 provider 返回的 raw_content（完整正文，质量高于 snippet）
	const rawContent = await env.cache.findRawContentByUrl(canonicalUrl, canonicalizeUrl);
	if (rawContent && rawContent.length >= MIN_BODY_CHARS) {
		const sourceId = await upgradeSource(env, url, rawContent, "raw_content");
		return { sourceId, body: rawContent, strategy: "raw_content" };
	}
	// 兜底：既有 Source 的 snippet 正文
	const existing = env.run.sources.find((s) => s.canonicalUrl === canonicalUrl);
	if (existing) {
		const body = await env.store.readSourceBody(existing.id);
		if (body && body.length > 0) {
			return { sourceId: existing.id, body, strategy: existing.fetchStrategy };
		}
	}
	return undefined;
}
