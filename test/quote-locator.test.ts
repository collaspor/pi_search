/**
 * quote 三级定位测试（验收 A4）。
 * 不依赖网络与 LLM，纯函数。
 */

import { describe, expect, it } from "vitest";
import {
	DEFAULT_FUZZY_THRESHOLD,
	extractNumbers,
	locateQuote,
	MIN_FUZZY_LENGTH,
	similarity,
} from "../src/verify/quote-locator.ts";

const BODY = `2026年，全球AI Agent市场规模预计达到 1,280 亿美元，年增长率约为 34.5%。
据 Gartner 报告，"Agent 编排" 已成为企业采购的核心指标。
OpenAI、Anthropic、Google 三家占据了超过 70% 的市场份额。`;

describe("L1 exact 定位", () => {
	it("原文逐字命中", () => {
		const r = locateQuote(BODY, "OpenAI、Anthropic、Google 三家占据了超过 70% 的市场份额。");
		expect(r.found).toBe(true);
		if (r.found) {
			expect(r.level).toBe("exact");
			expect(BODY.slice(r.start, r.end)).toBe("OpenAI、Anthropic、Google 三家占据了超过 70% 的市场份额。");
		}
	});
	it("locator 区间可精确切回原 quote", () => {
		const quote = "全球AI Agent市场规模预计达到 1,280 亿美元";
		const r = locateQuote(BODY, quote);
		expect(r.found).toBe(true);
		if (r.found) expect(BODY.slice(r.start, r.end)).toBe(quote);
	});
});

describe("L2 normalized 定位", () => {
	it("全角引号与半角引号差异可命中", () => {
		// 原文含中文引号 “Agent 编排”，quote 用半角 "，逐字匹配不上，须走 normalized
		const body = `据 Gartner 报告，“Agent 编排” 已成为企业采购的核心指标。`;
		const r = locateQuote(body, '"Agent 编排" 已成为企业采购的核心指标');
		expect(r.found).toBe(true);
		if (r.found) {
			expect(r.level).toBe("normalized");
			// 映射回原文应包含中文引号
			expect(body.slice(r.start, r.end)).toContain("Agent 编排");
		}
	});
	it("空白折叠：quote 把换行写成空格仍可命中", () => {
		const r = locateQuote(BODY, "年增长率约为 34.5%。 据 Gartner 报告");
		expect(r.found).toBe(true);
		if (r.found) expect(r.level).not.toBe("exact");
	});
	it("零宽字符不阻断匹配", () => {
		const quoteWithZeroWidth = "OpenAI、Anthropic、​Google 三家"; // 含零宽字符
		const r = locateQuote(BODY, quoteWithZeroWidth);
		expect(r.found).toBe(true);
	});
});

describe("L3 fuzzy 定位与数字保护", () => {
	const LONG_QUOTE = "全球AI Agent市场规模预计达到 1,280 亿美元，年增长率约为 34.5%";

	it("相似度足够高且数字一致时命中 fuzzy", () => {
		// quote 与原文仅标点差异，数字完全一致
		const r = locateQuote(BODY, "全球AI Agent市场规模预计达到 1280 亿美元,年增长率约为 34.5%");
		expect(r.found).toBe(true);
		if (r.found) {
			expect(["normalized", "fuzzy"]).toContain(r.level);
			if (r.level === "fuzzy") expect(r.matchScore).toBeGreaterThanOrEqual(DEFAULT_FUZZY_THRESHOLD);
		}
	});

	it("数字被改动时即使相似度高也拒收", () => {
		// 把 34.5% 改成 84.5%，字符差异极小
		const tampered = "全球AI Agent市场规模预计达到 1,280 亿美元，年增长率约为 84.5%";
		const r = locateQuote(BODY, tampered);
		expect(r.found).toBe(false);
	});

	it("金额被改动时拒收", () => {
		const tampered = "全球AI Agent市场规模预计达到 9,280 亿美元，年增长率约为 34.5%";
		const r = locateQuote(BODY, tampered);
		expect(r.found).toBe(false);
	});

	it("fuzzy 阈值边界：相似度恰低于阈值拒收", () => {
		// 构造一个与原文差异较大的 quote（无数字，规避数字保护）
		const off = "某机构指出该领域企业级采购指标发生显著变化并持续演进至今";
		const r = locateQuote(BODY, off, { fuzzyThreshold: 0.99 });
		expect(r.found).toBe(false);
	});

	it("记录 matchScore", () => {
		const r = locateQuote(BODY, LONG_QUOTE);
		expect(r.found).toBe(true);
		if (r.found) expect(r.matchScore).toBeGreaterThan(0);
	});
});

describe("短引用保护", () => {
	it(`少于 ${MIN_FUZZY_LENGTH} 字符的 quote 禁用 fuzzy`, () => {
		const shortQuote = "市场份额约为 71.3%"; // 原文是 70%，短引用不得 fuzzy 蒙混
		const r = locateQuote(BODY, shortQuote);
		expect(r.found).toBe(false);
		if (!r.found) expect(r.reason).toContain("fuzzy disabled");
	});

	it("短引用 exact 仍然可用", () => {
		const r = locateQuote(BODY, "70% 的市场份额");
		expect(r.found).toBe(true);
		if (r.found) expect(r.level).toBe("exact");
	});
});

describe("extractNumbers", () => {
	it("提取并归一化千分位", () => {
		expect(extractNumbers("达到 1,280 亿美元，增长 34.5%")).toEqual(["1280", "34.5%"]);
	});
	it("无数字返回空数组", () => {
		expect(extractNumbers("没有任何数字")).toEqual([]);
	});
});

describe("similarity", () => {
	it("完全相同为 1", () => expect(similarity("abc", "abc")).toBe(1));
	it("完全不同接近 0", () => expect(similarity("aaaa", "bbbb")).toBe(0));
	it("单字符差异", () => {
		const s = similarity("营收增长30%", "营收增长80%");
		expect(s).toBeGreaterThan(0.7);
		expect(s).toBeLessThan(1);
	});
	it("空字符串", () => {
		expect(similarity("", "abc")).toBe(0);
		expect(similarity("abc", "")).toBe(0);
	});
});

describe("拒收场景", () => {
	it("完全不存在的 quote", () => {
		const r = locateQuote(BODY, "微软公司以绝对优势领跑整个市场份额达到95%以上");
		expect(r.found).toBe(false);
	});
	it("空 quote", () => {
		expect(locateQuote(BODY, "").found).toBe(false);
	});
});
