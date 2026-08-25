/**
 * HTML 溯源报告导出（PRD 附录 B · M8 后增量）。
 *
 * 把 report.md 渲染为自包含的 report.html（inline CSS/JS/证据数据，无外部资源）：
 * 正文中的 [^e3] 引用渲染为可点按钮，点击展开证据面板——quote 在原始网页
 * 正文中的上下文高亮、来源链接、定位级别（exact/normalized/fuzzy）。
 *
 * 安全红线（与 §9.2 同级）：正文/quote/标题全部来自未受信网页。
 *   - 一切动态文本先 escapeHtml 再进入标记
 *   - 前端 JS 只写 textContent（context 三段分离，quote 仅靠 <mark> 标签高亮）
 *   - 来源链接协议白名单（http/https），其余降级为纯文本
 *   - 证据 JSON 内嵌时 < 转 \u003c（防 </script> 逃逸）
 *   - CSP: default-src 'none'——禁止一切网络资源加载（即使注入了 <img> 也不发请求）
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Evidence, ResearchRun, Source } from "../types.ts";
import { stripFootnoteDefinitions } from "./markdown.ts";

// ============================================================================
// 转义与 URL 过滤
// ============================================================================

/** HTML 文本转义（untrusted.ts 的 escapeAttr 为私有，此处独立实现文本版） */
export function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/** 仅 http/https 允许渲染为可点链接；其余（javascript: 等）返回 undefined 降级纯文本 */
export function safeUrl(url: string): string | undefined {
	if (/^https?:\/\//i.test(url)) return url;
	return undefined;
}

// ============================================================================
// Markdown 渲染（子集：报告结构由 markdown.ts 生成，语法面已知可控）
// ============================================================================

/** 行内语法：code / bold / italic / link / 引用按钮。输入必须先过 escapeHtml。 */
function renderInline(escaped: string): string {
	let out = escaped;
	// [^e12] → 可点引用按钮（脚注定义行已被剥离，正文中剩余的都是引用）
	out = out.replace(/\[\^(e\d+)\]/g, '<button class="cite" data-ev="$1" title="查看证据">$1</button>');
	// [text](url) → a（协议白名单；url 支持一层嵌套括号如 wikipedia 链接）
	out = out.replace(/\[([^\]]+)\]\(((?:[^()\\]|\\.|\([^()]*\))+)\)/g, (_m, text: string, url: string) => {
		const safe = safeUrl(url);
		if (!safe) return `${text}（${url}）`;
		return `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
	});
	out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
	out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
	out = out.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
	return out;
}

/** 行级渲染：标题 / hr / 无序与有序列表 / 段落。输入为未转义 markdown 文本。 */
export function renderMarkdown(md: string): string {
	const body = stripFootnoteDefinitions(md);
	const lines = body.split("\n");
	const html: string[] = [];
	let para: string[] = [];
	let list: { ordered: boolean; items: string[] } | undefined;

	const flushPara = () => {
		if (para.length > 0) {
			html.push(`<p>${para.map((l) => renderInline(escapeHtml(l))).join("<br>")}</p>`);
			para = [];
		}
	};
	const flushList = () => {
		if (list) {
			const tag = list.ordered ? "ol" : "ul";
			html.push(`<${tag}>${list.items.map((i) => `<li>${renderInline(escapeHtml(i))}</li>`).join("")}</${tag}>`);
			list = undefined;
		}
	};

	for (const line of lines) {
		const heading = /^(#{1,6})\s+(.+)$/.exec(line);
		if (heading) {
			flushPara();
			flushList();
			const level = Math.min(heading[1].length, 6); // 报告章节为 ## 起 → 页面 h2；页面 h1 留给 query
			html.push(`<h${level}>${renderInline(escapeHtml(heading[2]))}</h${level}>`);
			continue;
		}
		if (/^\s*---+\s*$/.test(line)) {
			flushPara();
			flushList();
			html.push("<hr>");
			continue;
		}
		const ul = /^\s*-\s+(.+)$/.exec(line);
		const ol = /^\s*\d+\.\s+(.+)$/.exec(line);
		if (ul || ol) {
			flushPara();
			const ordered = ul === null;
			if (!list || list.ordered !== ordered) flushList();
			list = list ?? { ordered, items: [] };
			list.items.push((ul ?? ol)![1]);
			continue;
		}
		flushList();
		if (line.trim() === "") {
			flushPara();
		} else {
			para.push(line);
		}
	}
	flushPara();
	flushList();
	return html.join("\n");
}

// ============================================================================
// 证据上下文提取（locator 区间 → 前后文切片）
// ============================================================================

const CONTEXT_RADIUS = 300;
const QUOTE_DISPLAY_MAX = 600;

export interface EvidenceContext {
	before: string;
	quote: string;
	after: string;
	/** quote 因超长被截断中间段 */
	truncated: boolean;
}

/** 从 source 正文切出 quote 上下文。正文缺失返回 undefined。 */
export function extractContext(
	body: string | undefined,
	locator: { start: number; end: number },
): EvidenceContext | undefined {
	if (body === undefined) return undefined;
	const start = Math.max(0, Math.min(locator.start, body.length));
	const end = Math.max(start, Math.min(locator.end, body.length));
	let quote = body.slice(start, end);
	let truncated = false;
	if (quote.length > QUOTE_DISPLAY_MAX) {
		quote = `${quote.slice(0, 280)}\n… [中间省略 ${end - start - 560} 字符] …\n${quote.slice(-280)}`;
		truncated = true;
	}
	return {
		before: body.slice(Math.max(0, start - CONTEXT_RADIUS), start),
		quote,
		after: body.slice(end, Math.min(body.length, end + CONTEXT_RADIUS)),
		truncated,
	};
}

// ============================================================================
// 页面组装
// ============================================================================

interface PanelEvidence {
	id: string;
	taskId: string;
	level: Evidence["quoteMatch"];
	score: number;
	quote: string;
	summary: string;
	context: EvidenceContext | null;
	source: { title: string; url: string | null; domain: string; retrievedAt: number } | null;
}

function levelLabel(level: Evidence["quoteMatch"], score: number): string {
	if (level === "exact") return "exact 原文逐字命中";
	if (level === "normalized") return "normalized 归一化命中（标点/空白差异）";
	return `fuzzy 模糊命中（相似度 ${score.toFixed(3)}，请留意差异）`;
}

/** 渲染完整自包含 HTML 页面（纯函数） */
export function renderReportHtml(input: {
	run: ResearchRun;
	markdown: string;
	sourceBodies: Map<string, string>;
}): string {
	const { run, markdown, sourceBodies } = input;
	const sourcesById = new Map(run.sources.map((s) => [s.id, s]));

	// 面板数据：每条 evidence 的上下文 + 来源元信息
	const panel: Record<string, PanelEvidence> = {};
	for (const ev of run.evidence) {
		const source = sourcesById.get(ev.sourceId);
		panel[ev.id] = {
			id: ev.id,
			taskId: ev.taskId,
			level: ev.quoteMatch,
			score: ev.matchScore ?? 1,
			quote: ev.quote,
			summary: ev.summary,
			context: extractContext(sourceBodies.get(ev.sourceId), ev.locator) ?? null,
			source: source
				? {
						title: source.title || "(untitled)",
						url: safeUrl(source.url) ?? null,
						domain: source.domain,
						retrievedAt: source.retrievedAt,
					}
				: null,
		};
	}

	// 文末参考来源：按正文引用顺序
	const citedOrder: string[] = [];
	for (const m of markdown.matchAll(/\[\^(e\d+)\]/g)) {
		if (!citedOrder.includes(m[1])) citedOrder.push(m[1]);
	}
	const refItems = citedOrder
		.map((id) => {
			const ev = run.evidence.find((e) => e.id === id);
			const source = ev ? sourcesById.get(ev.sourceId) : undefined;
			if (!ev || !source) return "";
			const safe = safeUrl(source.url);
			const titleHtml = escapeHtml(source.title || "(untitled)");
			const link = safe ? `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${titleHtml}</a>` : titleHtml;
			const fuzzyClass = ev.quoteMatch === "fuzzy" ? " fuzzy" : "";
			return `<li id="ref-${id}" class="ref${fuzzyClass}"><button class="cite" data-ev="${id}">${id}</button> ${link} <span class="ref-meta">${escapeHtml(source.domain)} · ${levelLabel(ev.quoteMatch, ev.matchScore ?? 1)}</span></li>`;
		})
		.filter((s) => s !== "");

	const statusLabel: Record<string, string> = {
		completed: "completed 全部完成",
		partial: "partial 部分完成（存在降级）",
		failed: "failed 未完成",
	};
	const status = statusLabel[run.status] ?? run.status;
	const generatedAt = new Date(run.updatedAt).toISOString().replace("T", " ").slice(0, 19);
	const panelJson = JSON.stringify(panel).replace(/</g, "\\u003c");

	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
<title>调研报告：${escapeHtml(run.query)}</title>
<style>
:root { --fg: #1f2328; --muted: #656d76; --border: #d1d9e0; --accent: #0969da; --mark: #fff3bf; }
* { box-sizing: border-box; }
body { margin: 0; font: 15px/1.7 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; color: var(--fg); background: #f6f8fa; }
.wrap { max-width: 860px; margin: 0 auto; padding: 32px 20px 120px; background: #fff; min-height: 100vh; }
header.masthead { border-bottom: 1px solid var(--border); padding-bottom: 16px; margin-bottom: 24px; }
h1.query { font-size: 20px; margin: 0 0 8px; }
.meta { color: var(--muted); font-size: 13px; display: flex; flex-wrap: wrap; gap: 14px; }
.badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 12px; font-weight: 600; }
.badge-completed { background: #dafbe1; color: #116329; }
.badge-partial { background: #fff8c5; color: #7d4e00; }
.badge-failed { background: #ffebe9; color: #a40e26; }
h2 { font-size: 18px; margin-top: 32px; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
h3 { font-size: 16px; margin-top: 24px; }
code { background: #eff1f3; padding: 1px 5px; border-radius: 4px; font-size: 13px; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
hr { border: none; border-top: 1px solid var(--border); margin: 28px 0; }
button.cite { background: #ddf4ff; color: var(--accent); border: 1px solid #b6e3ff; border-radius: 4px; font-size: 12px; padding: 0 5px; cursor: pointer; font-family: inherit; vertical-align: baseline; }
button.cite:hover { background: #b6e3ff; }
button.cite.fuzzy { background: #fff1e0; border-color: #ffd8a8; color: #b25e09; }
ol.refs { padding-left: 22px; font-size: 14px; }
ol.refs li { margin: 8px 0; }
.ref-meta { color: var(--muted); font-size: 12px; margin-left: 6px; }
#evidence-panel { position: fixed; left: 0; right: 0; bottom: 0; background: #fff; border-top: 2px solid var(--accent); box-shadow: 0 -4px 24px rgba(0,0,0,.12); padding: 16px 24px 20px; max-height: 55vh; overflow-y: auto; z-index: 10; }
#evidence-panel .ep-head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
#evidence-panel h3 { margin: 0; font-size: 15px; }
.ep-level { font-size: 12px; padding: 1px 8px; border-radius: 10px; background: #dafbe1; color: #116329; }
.ep-level.normalized { background: #ddf4ff; color: #0550ae; }
.ep-level.fuzzy { background: #fff1e0; color: #b25e09; }
.ep-close { margin-left: auto; background: none; border: 1px solid var(--border); border-radius: 6px; padding: 2px 10px; cursor: pointer; color: var(--muted); }
.ep-context { background: #f6f8fa; border-left: 3px solid var(--border); margin: 12px 0; padding: 10px 14px; font-size: 13.5px; color: #444; white-space: pre-wrap; word-break: break-word; max-height: 30vh; overflow-y: auto; }
.ep-context mark { background: var(--mark); padding: 0 1px; border-radius: 2px; }
.ep-summary { font-size: 13px; color: var(--muted); margin: 8px 0; }
.ep-source { font-size: 13.5px; margin: 8px 0; }
.ep-meta { font-size: 12px; color: var(--muted); }
.ep-missing { color: #a40e26; font-size: 13px; }
</style>
</head>
<body>
<div class="wrap">
<header class="masthead">
<h1 class="query">${escapeHtml(run.query)}</h1>
<div class="meta">
<span class="badge badge-${run.status}">${escapeHtml(status)}</span>
<span>${run.sources.length} 来源 · ${run.evidence.length} 证据 · ${run.claims.length} 结论</span>
<span>↑${run.budget.usedTokens} tokens · $${run.budget.usedCostUsd.toFixed(4)}</span>
<span>生成于 ${generatedAt}</span>
<span>run ${escapeHtml(run.id)}</span>
</div>
</header>
<main id="report">
${renderMarkdown(markdown)}
</main>
${refItems.length > 0 ? `<h2>参考来源（${refItems.length}）</h2>\n<ol class="refs">\n${refItems.join("\n")}\n</ol>` : ""}
</div>
<aside id="evidence-panel" hidden>
<div class="ep-head">
<h3 id="ep-title"></h3>
<span class="ep-level" id="ep-level"></span>
<button class="ep-close" id="ep-close">关闭 Esc</button>
</div>
<div id="ep-body"></div>
</aside>
<script type="application/json" id="evidence-data">${panelJson}</script>
<script>(function(){
var data=JSON.parse(document.getElementById("evidence-data").textContent);
var panel=document.getElementById("evidence-panel");
var body=document.getElementById("ep-body");
var title=document.getElementById("ep-title");
var level=document.getElementById("ep-level");
function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;e.textContent=text||"";return e;}
function show(id){
var ev=data[id];if(!ev)return;
title.textContent="证据 "+ev.id+"（任务 "+ev.taskId+"）";
level.className="ep-level "+ev.level;
level.textContent=ev.level==="exact"?"exact 原文逐字命中":ev.level==="normalized"?"normalized 归一化命中":"fuzzy 模糊命中 score="+ev.score.toFixed(3);
body.textContent="";
if(ev.context){
var bq=el("blockquote","ep-context");
bq.appendChild(document.createTextNode(ev.context.before));
var mark=document.createElement("mark");mark.textContent=ev.context.quote;bq.appendChild(mark);
bq.appendChild(document.createTextNode(ev.context.after));
body.appendChild(bq);
if(ev.context.truncated)body.appendChild(el("p","ep-meta","quote 过长，中间部分省略显示"));
}else{
body.appendChild(el("p","ep-missing","原文快照不可用（sources 文件缺失），以下为记录的引用原文："));
var q=el("blockquote","ep-context");var mk=document.createElement("mark");mk.textContent=ev.quote;q.appendChild(mk);body.appendChild(q);
}
if(ev.summary)body.appendChild(el("p","ep-summary","模型归纳："+ev.summary));
if(ev.source){
var p=el("p","ep-source","");
if(ev.source.url){var a=document.createElement("a");a.href=ev.source.url;a.target="_blank";a.rel="noopener noreferrer";a.textContent=ev.source.title;p.appendChild(a);}else{p.appendChild(document.createTextNode(ev.source.title));}
body.appendChild(p);
body.appendChild(el("p","ep-meta",ev.source.domain+" · 检索于 "+new Date(ev.source.retrievedAt).toISOString().slice(0,10)));
}
panel.hidden=false;
}
document.querySelectorAll("button.cite").forEach(function(b){b.addEventListener("click",function(){show(b.dataset.ev);});});
document.getElementById("ep-close").addEventListener("click",function(){panel.hidden=true;});
document.addEventListener("keydown",function(e){if(e.key==="Escape")panel.hidden=true;});
})();</script>
</body>
</html>
`;
}

// ============================================================================
// IO 封装：读 sources → 渲染 → 原子写 report.html
// ============================================================================

/** 导出 run 的 HTML 溯源报告，返回落盘路径。缺失的 source 正文降级为"快照不可用"。 */
export async function exportRunHtml(runDir: string, run: ResearchRun, markdown: string): Promise<string> {
	const sourceBodies = new Map<string, string>();
	for (const source of run.sources) {
		if (!source.bodyRef) continue;
		try {
			sourceBodies.set(source.id, await readFile(join(runDir, source.bodyRef), "utf8"));
		} catch {
			// 正文文件缺失：该来源的证据面板降级显示 quote 本身
		}
	}
	const html = renderReportHtml({ run, markdown, sourceBodies });
	const path = join(runDir, "report.html");
	const tmp = `${path}.tmp`;
	await writeFile(tmp, html, "utf8");
	await rename(tmp, path);
	return path;
}
