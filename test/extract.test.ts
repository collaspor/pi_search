/**
 * 正文提取降级链测试（PRD §8.2）。
 * 全部本地 HTML fixture，不触网。
 */

import { describe, expect, it } from "vitest";
import {
	cleanText,
	extractBody,
	extractPlaintext,
	extractWithReadability,
	MIN_BODY_CHARS,
} from "../src/net/extract.ts";

const LONG_PARAGRAPH =
	"人工智能代理市场在2026年经历了前所未有的增长，企业级采购成为核心驱动力。根据多家研究机构的联合报告，" +
	"市场规模预计突破千亿美元大关，年增长率维持在百分之三十以上。这一趋势的背后是大模型能力的持续演进，" +
	"以及企业对自动化工作流的迫切需求。主要厂商纷纷推出面向开发者的代理编排平台，试图在标准制定中占据主导地位。".repeat(
		3,
	);

const ARTICLE_HTML = `<!DOCTYPE html>
<html><head><title>2026年AI Agent市场报告</title></head>
<body>
<nav><a href="/">首页</a><a href="/nav">导航链接一</a></nav>
<article>
<h1>2026年AI Agent市场报告</h1>
<p>${LONG_PARAGRAPH}</p>
<p>${LONG_PARAGRAPH}</p>
</article>
<footer>版权所有 © 2026 某公司</footer>
</body></html>`;

const NAV_HEAVY_HTML = `<!DOCTYPE html>
<html><head><title>导航很多的页面</title></head>
<body>
<nav>${"<a href='/x'>链接</a>".repeat(200)}</nav>
<div>
<p>${LONG_PARAGRAPH}</p>
</div>
<script>console.log("tracking")</script>
</body></html>`;

const EMPTY_HTML = `<!DOCTYPE html>
<html><head><title>空页面</title></head>
<body><script>var x=1;</script><div id="app"></div></body></html>`;

describe("extractWithReadability", () => {
	it("从标准文章页提取正文与标题", () => {
		const r = extractWithReadability(ARTICLE_HTML, "https://example.com/report");
		expect(r).toBeDefined();
		expect(r?.strategy).toBe("readability");
		expect(r?.text.length).toBeGreaterThanOrEqual(MIN_BODY_CHARS);
		expect(r?.text).toContain("人工智能代理市场");
	});

	it("正文过短返回 undefined", () => {
		const short = `<html><body><article><p>太短了</p></article></body></html>`;
		expect(extractWithReadability(short, "https://example.com")).toBeUndefined();
	});

	it("空页面返回 undefined", () => {
		expect(extractWithReadability(EMPTY_HTML, "https://example.com")).toBeUndefined();
	});
});

describe("extractPlaintext", () => {
	it("剥除 script/nav 后取文本", () => {
		const r = extractPlaintext(NAV_HEAVY_HTML);
		expect(r).toBeDefined();
		expect(r?.text).toContain("人工智能代理市场");
		expect(r?.text).not.toContain("tracking");
		expect(r?.text).not.toContain("链接链接");
	});

	it("空页面返回 undefined", () => {
		expect(extractPlaintext(EMPTY_HTML)).toBeUndefined();
	});
});

describe("extractBody 降级链", () => {
	it("优先 readability", () => {
		const r = extractBody(ARTICLE_HTML, "https://example.com/report");
		expect(r?.strategy).toBe("readability");
	});

	it("readability 失败时降级到 plaintext 或返回 undefined", () => {
		// 无 article 结构的纯 div 页面
		const divOnly = `<html><body><div><p>${LONG_PARAGRAPH}</p></div></body></html>`;
		const r = extractBody(divOnly, "https://example.com");
		if (r !== undefined) {
			expect(r.text).toContain("人工智能代理市场");
		}
		// 两个都失败时才 undefined，EMPTY_HTML 必须 undefined
		expect(extractBody(EMPTY_HTML, "https://example.com")).toBeUndefined();
	});
});

describe("cleanText", () => {
	it("压缩多余空白", () => {
		expect(cleanText("a  b\t\nc\n\n\nd")).toBe("a b \nc\n\nd");
	});
});
