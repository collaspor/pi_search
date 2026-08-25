/**
 * HTML 溯源报告导出测试（纯函数，无 IO 无 LLM）。
 * 覆盖：渲染正确性、XSS 转义、context 切片、URL 协议过滤、JSON 内嵌转义。
 */

import { describe, expect, it } from "vitest";
import { escapeHtml, extractContext, renderMarkdown, renderReportHtml, safeUrl } from "../src/report/html.ts";
import type { Evidence, ResearchRun, Source } from "../src/types.ts";

function makeEvidence(overrides?: Partial<Evidence>): Evidence {
	return {
		id: "e1",
		taskId: "T1",
		sourceId: "s1",
		quote: "the quick brown fox",
		summary: "s1 states the fox fact",
		locator: { start: 10, end: 29 },
		stance: "support",
		quoteMatch: "exact",
		matchScore: 1,
		createdAt: 0,
		...overrides,
	};
}

function makeSource(overrides?: Partial<Source>): Source {
	return {
		id: "s1",
		url: "https://example.com/fox",
		canonicalUrl: "https://example.com/fox",
		title: "Fox Facts",
		domain: "example.com",
		retrievedAt: 1787650000000,
		tier: 2,
		fetchStrategy: "raw_content",
		contentHash: "abc",
		charCount: 100,
		bodyRef: "sources/s1.txt",
		...overrides,
	};
}

function makeRun(evidence: Evidence[], sources: Source[]): ResearchRun {
	return {
		id: "run-test",
		query: "test query",
		status: "completed",
		createdAt: 0,
		updatedAt: 1787650000000,
		schemaVersion: 1,
		sources,
		evidence,
		claims: [],
		budget: {
			maxTokens: 1000,
			maxCostUsd: 1,
			maxWallClockMs: 5000,
			maxTasks: 8,
			maxFetchPerTask: 5,
			usedTokens: 100,
			usedCostUsd: 0.001,
			startedAt: 0,
		},
		recoveries: [],
		lastSeq: 0,
	};
}

describe("renderMarkdown 渲染子集", () => {
	it("标题 / 加粗 / 列表 / 引用按钮", () => {
		const md = "## 章节标题\n\n含 **重点** 的段落，引用[^e1]在此。\n\n- 第一项\n- 第二项[^e2]\n";
		const html = renderMarkdown(md);
		expect(html).toContain("<h2>章节标题</h2>");
		expect(html).toContain("<strong>重点</strong>");
		expect(html).toContain('<button class="cite" data-ev="e1"');
		expect(html).toContain("<ul>");
		expect(html).toContain("<li>第一项</li>");
		expect(html).toContain('<button class="cite" data-ev="e2"');
	});

	it("脚注定义行被剥离（由代码重建，不信 LLM 自写）", () => {
		const md = "正文[^e1]。\n\n---\n\n[^e1]: [Fake](https://evil.example) — 伪造定义\n";
		const html = renderMarkdown(md);
		expect(html).not.toContain("evil.example");
		expect(html).toContain("正文");
	});
});

describe("XSS 防线", () => {
	it("正文中的 script 注入被转义", () => {
		const html = renderMarkdown("段落 <script>alert(1)</script> 结束");
		expect(html).not.toContain("<script>alert");
		expect(html).toContain("&lt;script&gt;");
	});

	it("escapeHtml 覆盖五个危险字符", () => {
		expect(escapeHtml(`<a href="x">&'`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
	});

	it("javascript: 协议的链接降级为纯文本", () => {
		const html = renderMarkdown("[点我](javascript:alert(1))");
		expect(html).not.toContain("<a href");
		expect(html).toContain("点我（javascript:alert(1)）");
	});
});

describe("safeUrl 协议白名单", () => {
	it("http/https 放行", () => {
		expect(safeUrl("https://a.com")).toBe("https://a.com");
		expect(safeUrl("http://a.com")).toBe("http://a.com");
	});
	it("javascript:/data:/file: 拒绝", () => {
		expect(safeUrl("javascript:alert(1)")).toBeUndefined();
		expect(safeUrl("data:text/html,<script>")).toBeUndefined();
		expect(safeUrl("file:///etc/passwd")).toBeUndefined();
	});
});

describe("extractContext 上下文切片", () => {
	it("locator 区间精确高亮，前后各带上下文", () => {
		const body = `${"a".repeat(400)}QUOTEBODY${"b".repeat(400)}`;
		const start = 400;
		const ctx = extractContext(body, { start, end: start + 9 });
		expect(ctx).toBeDefined();
		expect(ctx!.quote).toBe("QUOTEBODY");
		expect(ctx!.before.endsWith("a".repeat(300))).toBe(true);
		expect(ctx!.before.length).toBe(300);
		expect(ctx!.after.length).toBe(300);
		expect(ctx!.truncated).toBe(false);
	});

	it("超长 quote 中间截断", () => {
		const body = "x".repeat(2000);
		const ctx = extractContext(body, { start: 100, end: 1100 });
		expect(ctx!.truncated).toBe(true);
		expect(ctx!.quote).toContain("中间省略");
	});

	it("正文缺失返回 undefined", () => {
		expect(extractContext(undefined, { start: 0, end: 5 })).toBeUndefined();
	});
});

describe("renderReportHtml 整页组装", () => {
	it("引用按钮 + 参考来源列表 + 面板数据", () => {
		const run = makeRun([makeEvidence()], [makeSource()]);
		const html = renderReportHtml({
			run,
			markdown: "结论一句话[^e1]。\n\n[^e1]: [Fox](https://example.com/fox) — 检索于 2026-08-25\n",
			sourceBodies: new Map([["s1", "0123456789the quick brown fox jumps"]]),
		});
		expect(html).toContain('<button class="cite" data-ev="e1"');
		expect(html).toContain('id="ref-e1"');
		expect(html).toContain('id="evidence-data"');
		expect(html).toContain("Fox Facts");
		expect(html).toContain("badge-completed");
	});

	it("面板 JSON 中的 </script> 被转义（防内嵌逃逸）", () => {
		const evil = makeEvidence({ quote: 'x</script><script>alert(1)</script>' });
		const run = makeRun([evil], [makeSource()]);
		const html = renderReportHtml({ run, markdown: "[^e1]\n", sourceBodies: new Map() });
		expect(html).not.toContain("</script><script>alert");
		expect(html).toContain("\\u003c/script>");
	});

	it("fuzzy 证据在参考来源中带警示样式与相似度", () => {
		const fuzzy = makeEvidence({ quoteMatch: "fuzzy", matchScore: 0.93 });
		const run = makeRun([fuzzy], [makeSource()]);
		const html = renderReportHtml({ run, markdown: "[^e1]\n", sourceBodies: new Map() });
		expect(html).toContain('class="ref fuzzy"');
		expect(html).toContain("0.930");
	});

	it("正文来源注入的恶意标题被转义", () => {
		const src = makeSource({ title: '<img src=x onerror=alert(1)>' });
		const run = makeRun([makeEvidence()], [src]);
		const html = renderReportHtml({ run, markdown: "[^e1]\n", sourceBodies: new Map() });
		expect(html).not.toContain("<img src=x");
		expect(html).toContain("&lt;img src=x");
	});
});
