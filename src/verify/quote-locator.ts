/**
 * quote 三级定位（PRD §6.2，验收 A4）。
 *
 * evidence.quote 必须能在 source 正文中定位，否则拒收。三级逐级放宽：
 *   exact      原文 indexOf 直接命中
 *   normalized 双方归一化后命中（全角/半角、空白折叠、零宽字符）
 *   fuzzy      滑动窗口 + 相似度 ≥ 阈值（有附加保护，见下）
 *
 * fuzzy 的两条保护（PRD §6.2 评审修正）：
 *   1. quote.length < MIN_FUZZY_LENGTH 时禁用 fuzzy——短引用没有模糊匹配的余地
 *   2. quote 与候选窗口中的数字（含百分比/小数）必须逐一完全相等，
 *      否则即使相似度达标也拒收——研究报告的核心价值在数据
 */

import type { QuoteMatchLevel } from "../types.ts";

export const MIN_FUZZY_LENGTH = 30;
export const DEFAULT_FUZZY_THRESHOLD = 0.9;

export interface LocateOk {
	found: true;
	level: QuoteMatchLevel;
	start: number; // 原文字符下标
	end: number;
	matchScore: number; // exact/normalized 恒为 1
}

export interface LocateFail {
	found: false;
	reason: string;
}

export type LocateResult = LocateOk | LocateFail;

// ============================================================================
// 归一化（带原文位置映射）
// ============================================================================

/** 零宽字符集合：ZWSP ZWNJ ZWJ WJ BOM。用 Set + 逐字符判断，避免字符类对 ZWJ 的误报。 */
const ZERO_WIDTH_CHARS = new Set(["​", "‌", "‍", "⁠", "﻿"]);

function isZeroWidth(ch: string): boolean {
	return ZERO_WIDTH_CHARS.has(ch);
}
/** 全角字符范围（不含全角空格，单独处理） */
const FULLWIDTH_START = 0xff01;
const FULLWIDTH_END = 0xff5e;
const FULLWIDTH_OFFSET = 0xfee0;

const PUNCT_MAP: Record<string, string> = {
	"“": '"',
	"”": '"',
	"‘": "'",
	"’": "'",
	"，": ",",
	"。": ".",
	"；": ";",
	"：": ":",
	"？": "?",
	"！": "!",
	"（": "(",
	"）": ")",
	"【": "[",
	"】": "]",
	"《": "<",
	"》": ">",
	"…": "...",
	"—": "-",
	"–": "-",
};

interface NormalizedWithMap {
	normalized: string;
	/** normalized[i] 对应原文字符串的下标 */
	origPos: number[];
}

/**
 * 归一化文本并保留每个归一化字符对应的原文位置。
 * 折叠连续空白为单个空格——这是长度变化的主要来源，必须靠 origPos 映射回原文。
 */
function normalizeWithMap(text: string): NormalizedWithMap {
	const normalizedChars: string[] = [];
	const origPos: number[] = [];
	let pendingSpace = false;

	for (let i = 0; i < text.length; i++) {
		let ch = text[i];
		// 跳过零宽字符（不进归一化结果，也不占 origPos）
		if (isZeroWidth(ch)) continue;
		const code = ch.charCodeAt(0);

		// 全角 ASCII 转半角
		if (code >= FULLWIDTH_START && code <= FULLWIDTH_END) {
			ch = String.fromCharCode(code - FULLWIDTH_OFFSET);
		} else if (code === 0x3000) {
			ch = " "; // 全角空格
		} else if (PUNCT_MAP[ch] !== undefined) {
			ch = PUNCT_MAP[ch];
		}

		if (/\s/.test(ch)) {
			pendingSpace = true;
			continue;
		}
		if (pendingSpace && normalizedChars.length > 0) {
			normalizedChars.push(" ");
			origPos.push(i); // 空白折叠：映射到第一个非空白字符前的位置（近似）
		}
		pendingSpace = false;
		normalizedChars.push(ch);
		origPos.push(i);
	}

	return { normalized: normalizedChars.join(""), origPos };
}

// ============================================================================
// 数字保护
// ============================================================================

const NUMBER_RE = /[\d][\d,]*\.?\d*%?/g;

/** 提取文本中的数字 token（去逗号归一）。 */
export function extractNumbers(text: string): string[] {
	const matches = text.match(NUMBER_RE) ?? [];
	return matches.map((m) => m.replace(/,/g, ""));
}

function numbersEqual(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	return a.every((v, i) => v === b[i]);
}

// ============================================================================
// 相似度（归一化 Levenshtein）
// ============================================================================

/** 归一化编辑距离相似度，1 = 完全相同。 */
export function similarity(a: string, b: string): number {
	if (a === b) return 1;
	const la = a.length;
	const lb = b.length;
	if (la === 0 || lb === 0) return 0;

	// 两行 DP，内存 O(min(la,lb))
	const shorter = la <= lb ? a : b;
	const longer = la <= lb ? b : a;
	let prev = new Array<number>(shorter.length + 1);
	let curr = new Array<number>(shorter.length + 1);
	for (let j = 0; j <= shorter.length; j++) prev[j] = j;

	for (let i = 1; i <= longer.length; i++) {
		curr[0] = i;
		for (let j = 1; j <= shorter.length; j++) {
			const cost = longer[i - 1] === shorter[j - 1] ? 0 : 1;
			curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
		}
		[prev, curr] = [curr, prev];
	}
	const distance = prev[shorter.length];
	return 1 - distance / Math.max(la, lb);
}

// ============================================================================
// 三级定位
// ============================================================================

export interface LocateOptions {
	fuzzyThreshold?: number;
}

export function locateQuote(body: string, quote: string, options?: LocateOptions): LocateResult {
	if (quote.length === 0) {
		return { found: false, reason: "empty quote" };
	}

	// L1 exact
	const exactIdx = body.indexOf(quote);
	if (exactIdx !== -1) {
		return { found: true, level: "exact", start: exactIdx, end: exactIdx + quote.length, matchScore: 1 };
	}

	// L2 normalized
	const bodyNorm = normalizeWithMap(body);
	const quoteNorm = normalizeWithMap(quote);
	const normIdx = bodyNorm.normalized.indexOf(quoteNorm.normalized);
	if (normIdx !== -1 && quoteNorm.normalized.length > 0) {
		const start = bodyNorm.origPos[normIdx];
		const lastNormIdx = normIdx + quoteNorm.normalized.length - 1;
		const end = bodyNorm.origPos[lastNormIdx] + 1;
		return { found: true, level: "normalized", start, end, matchScore: 1 };
	}

	// L3 fuzzy——短引用禁用
	if (quote.length < MIN_FUZZY_LENGTH) {
		return {
			found: false,
			reason: `quote not found (exact/normalized); fuzzy disabled for quotes shorter than ${MIN_FUZZY_LENGTH} chars`,
		};
	}

	const threshold = options?.fuzzyThreshold ?? DEFAULT_FUZZY_THRESHOLD;
	const quoteNumbers = extractNumbers(quoteNorm.normalized);
	const windowLen = quoteNorm.normalized.length;

	let best: { score: number; start: number } | undefined;
	// 滑动窗口：以 quote 长度为基准，±20% 容差内取若干窗口尺寸
	for (const wLen of [windowLen, Math.ceil(windowLen * 1.1), Math.ceil(windowLen * 0.9)]) {
		for (let i = 0; i + wLen <= bodyNorm.normalized.length; i++) {
			const window = bodyNorm.normalized.slice(i, i + wLen);
			// 数字保护前置过滤：窗口必须先通过数字校验才值得算相似度
			if (quoteNumbers.length > 0 && !numbersEqual(quoteNumbers, extractNumbers(window))) {
				continue;
			}
			const score = similarity(quoteNorm.normalized, window);
			if (score >= threshold && (best === undefined || score > best.score)) {
				best = { score, start: i };
			}
		}
	}

	if (best === undefined) {
		return {
			found: false,
			reason: `quote not found within fuzzy threshold ${threshold} (numbers must match exactly)`,
		};
	}

	const start = bodyNorm.origPos[best.start];
	const endIdx = Math.min(best.start + windowLen - 1, bodyNorm.origPos.length - 1);
	const end = bodyNorm.origPos[endIdx] + 1;
	return { found: true, level: "fuzzy", start, end, matchScore: best.score };
}
