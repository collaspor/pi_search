/**
 * HTTP 客户端（PRD §8.2 工具级失败策略）。
 *
 * 指数退避 + 抖动重试，按错误类型差异化：
 *  - timeout / network：退避重试，上限 3
 *  - rate_limit (429)：读 Retry-After，无则 5s→15s→45s
 *  - http_4xx：不重试（重试无意义）
 *  - http_5xx：退避重试，上限 2
 *
 * 重定向 manual 处理，每跳重新走 SSRF 校验（§9.1 第 4 条，最易漏点）。
 * Provider 熔断器：连续失败 N 次 → open，冷却后半开试探。
 */

import type { Readable } from "node:stream";
import { Agent, request } from "undici";
import type { FailureType } from "../types.ts";
import { checkUrl, type SsrfCheckFail, type SsrfCheckOk } from "./ssrf-guard.ts";

export interface HttpFailure {
	ok: false;
	failureType: FailureType;
	status?: number;
	message: string;
	/** 429 时服务器要求的等待毫秒数（来自 Retry-After 头） */
	retryAfterMs?: number;
}

export interface HttpSuccess {
	ok: true;
	status: number;
	body: string;
	finalUrl: string;
	headers: Record<string, string | string[] | undefined>;
}

export type HttpResult = HttpSuccess | HttpFailure;

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024; // 5MB，防 zip bomb
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_UA = "pi-deep-research/0.84.2 (+https://github.com/earendil-works/pi; research bot)";

const BACKOFF_BASE_MS = [1_000, 2_000, 4_000] as const;
const RATE_LIMIT_BACKOFF_MS = [5_000, 15_000, 45_000] as const;

/** 抖动 ±30%，避免多 Task 同时重试形成惊群 */
function jitter(ms: number, random: () => number = Math.random): number {
	const spread = ms * 0.3;
	return Math.floor(ms - spread + random() * spread * 2);
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// 熔断器
// ============================================================================

export type BreakerState = "closed" | "open" | "half_open";

export class CircuitBreaker {
	private state: BreakerState = "closed";
	private consecutiveFailures = 0;
	private openedAt = 0;
	private readonly threshold: number;
	private readonly cooldownMs: number;

	constructor(threshold = 5, cooldownMs = 60_000) {
		this.threshold = threshold;
		this.cooldownMs = cooldownMs;
	}

	getState(now = Date.now()): BreakerState {
		if (this.state === "open" && now - this.openedAt >= this.cooldownMs) {
			return "half_open";
		}
		return this.state;
	}

	/** 调用前检查。open 期间返回 false（直接走备用），half_open 放行 1 次试探。 */
	canRequest(now = Date.now()): boolean {
		const state = this.getState(now);
		if (state === "open") return false;
		if (state === "half_open") {
			this.state = "half_open";
			return true;
		}
		return true;
	}

	recordSuccess(): void {
		this.consecutiveFailures = 0;
		this.state = "closed";
	}

	recordFailure(now = Date.now()): void {
		this.consecutiveFailures++;
		if (this.consecutiveFailures >= this.threshold || this.state === "half_open") {
			this.state = "open";
			this.openedAt = now;
		}
	}
}

// ============================================================================
// 单次请求（含 SSRF 与重定向循环）
// ============================================================================

export interface FetchOnceOptions {
	timeoutMs: number;
	maxBytes: number;
	maxRedirects: number;
	userAgent: string;
	signal?: AbortSignal;
	onBlocked?: (url: string, reason: string) => void;
}

async function readBodyWithLimit(stream: Readable, maxBytes: number): Promise<string> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of stream) {
		const buf = chunk as Buffer;
		total += buf.length;
		if (total > maxBytes) {
			chunks.push(buf.subarray(0, buf.length - (total - maxBytes)));
			stream.destroy();
			break;
		}
		chunks.push(buf);
	}
	return Buffer.concat(chunks).toString("utf8");
}

/** DNS rebinding 缓解：用校验通过的地址直连，Host 头保持原域名。 */
function pinnedLookup(addresses: string[]) {
	return (
		hostname: string,
		_options: unknown,
		callback: (err: Error | null, address: string | { address: string; family: number }[], family?: number) => void,
	) => {
		if (addresses.length === 0) {
			callback(new Error(`no pinned addresses for ${hostname}`), "");
			return;
		}
		const address = addresses[0];
		callback(null, address, address.includes(":") ? 6 : 4);
	};
}

function flattenHeaders(
	headers: Record<string, string | string[] | undefined>,
): Record<string, string | string[] | undefined> {
	const out: Record<string, string | string[] | undefined> = {};
	for (const [key, value] of Object.entries(headers)) {
		out[key.toLowerCase()] = value;
	}
	return out;
}

/**
 * 抓取一个 URL，manual 处理重定向，每跳重新 SSRF 校验。
 * 不重试（重试逻辑在 fetchWithRetry）。
 */
export async function fetchOnce(url: string, options: FetchOnceOptions): Promise<HttpResult> {
	let currentUrl = url;
	for (let redirectCount = 0; redirectCount <= options.maxRedirects; redirectCount++) {
		const check: SsrfCheckOk | SsrfCheckFail = await checkUrl(currentUrl);
		if (!check.ok) {
			options.onBlocked?.(currentUrl, check.reason);
			return { ok: false, failureType: "blocked_url", message: check.reason };
		}

		const dispatcher = new Agent({
			connect: {
				timeout: options.timeoutMs,
				lookup: check.addresses.length > 0 ? pinnedLookup(check.addresses) : undefined,
			},
		});

		try {
			const response = await request(currentUrl, {
				method: "GET",
				headers: {
					"user-agent": options.userAgent,
					accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
					"accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
				},
				// 重定向在下方 manual 处理（undici 8 的 request() 不再支持 maxRedirections）
				headersTimeout: options.timeoutMs,
				bodyTimeout: options.timeoutMs,
				dispatcher,
				signal: options.signal,
			});

			const headers = flattenHeaders(response.headers);
			const status = response.statusCode;

			if (status >= 300 && status < 400) {
				await response.body.dump();
				const location = headers.location;
				if (typeof location !== "string" || location === "") {
					return {
						ok: false,
						failureType: "http_4xx",
						status,
						message: `redirect without Location (status ${status})`,
					};
				}
				if (redirectCount === options.maxRedirects) {
					return {
						ok: false,
						failureType: "http_4xx",
						status,
						message: `too many redirects (>${options.maxRedirects})`,
					};
				}
				// 相对 Location 需解析为绝对 URL，下一跳重新校验
				currentUrl = new URL(location, currentUrl).toString();
				continue;
			}

			if (status >= 400 && status < 500) {
				await response.body.dump();
				const failure: HttpFailure = { ok: false, failureType: "http_4xx", status, message: `HTTP ${status}` };
				// 429：提取 Retry-After（秒数或 HTTP 日期），供重试延迟使用
				if (status === 429) {
					const retryAfter = headers["retry-after"];
					const value = Array.isArray(retryAfter) ? retryAfter[0] : retryAfter;
					if (typeof value === "string" && value !== "") {
						const seconds = Number(value);
						if (Number.isFinite(seconds)) {
							failure.retryAfterMs = seconds * 1000;
						} else {
							const date = Date.parse(value);
							if (!Number.isNaN(date)) failure.retryAfterMs = Math.max(0, date - Date.now());
						}
					}
				}
				return failure;
			}
			if (status >= 500) {
				await response.body.dump();
				return { ok: false, failureType: "http_5xx", status, message: `HTTP ${status}` };
			}

			const body = await readBodyWithLimit(response.body, options.maxBytes);
			return { ok: true, status, body, finalUrl: currentUrl, headers };
		} catch (err) {
			if (options.signal?.aborted) {
				return { ok: false, failureType: "timeout", message: "aborted" };
			}
			const message = err instanceof Error ? err.message : String(err);
			const isTimeout = /timeout|timed?\s*out|ETIMEDOUT/i.test(message);
			return {
				ok: false,
				failureType: isTimeout ? "timeout" : "network",
				message,
			};
		} finally {
			dispatcher.close().catch(() => {});
		}
	}
	// 循环必然返回，这里只是满足 TS
	return { ok: false, failureType: "network", message: "unreachable" };
}

// ============================================================================
// 带重试的抓取
// ============================================================================

export interface FetchWithRetryOptions extends FetchOnceOptions {
	maxRetries: number;
	breaker?: CircuitBreaker;
	onRetry?: (attempt: number, failureType: FailureType, delayMs: number) => void;
	sleeper?: (ms: number) => Promise<void>;
}

/**
 * 按错误类型差异化重试（PRD §8.2 L1）：
 *  - http_4xx / blocked_url：不重试
 *  - http_5xx：上限 2
 *  - timeout / network：上限 maxRetries（默认 3）
 *  - 429：Retry-After 优先，否则 rate_limit 退避序列
 */
export async function fetchWithRetry(url: string, options: FetchWithRetryOptions): Promise<HttpResult> {
	const sleeper = options.sleeper ?? sleep;

	if (options.breaker && !options.breaker.canRequest()) {
		return { ok: false, failureType: "network", message: "circuit breaker open" };
	}

	let lastResult: HttpResult | undefined;
	for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
		const result = await fetchOnce(url, options);

		if (result.ok) {
			options.breaker?.recordSuccess();
			return result;
		}

		// 4xx 特殊处理：429 是 rate_limit
		let failureType = result.failureType;
		if (result.status === 429) failureType = "rate_limit";
		lastResult = { ...result, failureType };

		const noRetry = failureType === "http_4xx" || failureType === "blocked_url";
		const retryLimit = failureType === "http_5xx" ? Math.min(options.maxRetries, 2) : options.maxRetries;

		if (noRetry || attempt >= retryLimit) {
			options.breaker?.recordFailure();
			return lastResult;
		}

		let delay: number;
		if (failureType === "rate_limit") {
			// Retry-After 优先（服务器明确要求），否则固定退避序列
			delay =
				result.retryAfterMs !== undefined && attempt === 0
					? result.retryAfterMs
					: RATE_LIMIT_BACKOFF_MS[Math.min(attempt, RATE_LIMIT_BACKOFF_MS.length - 1)];
		} else {
			delay = BACKOFF_BASE_MS[Math.min(attempt, BACKOFF_BASE_MS.length - 1)];
		}
		delay = jitter(delay);
		options.onRetry?.(attempt + 1, failureType, delay);
		await sleeper(delay);
	}

	return lastResult ?? { ok: false, failureType: "network", message: "unreachable" };
}

export function defaultFetchOptions(): FetchWithRetryOptions {
	return {
		timeoutMs: DEFAULT_TIMEOUT_MS,
		maxBytes: DEFAULT_MAX_BYTES,
		maxRedirects: DEFAULT_MAX_REDIRECTS,
		maxRetries: DEFAULT_MAX_RETRIES,
		userAgent: DEFAULT_UA,
	};
}
