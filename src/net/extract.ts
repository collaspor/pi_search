/**
 * 正文提取降级链（PRD §8.2 抓取降级链）。
 *
 *   1. Readability（Firefox 阅读模式算法，去广告导航）
 *      ↓ 失败 或 正文 < MIN_BODY_CHARS
 *   2. 纯文本提取（linkedom textContent + 清洗 script/style/nav/footer）
 *      ↓ 失败
 *   由调用方继续降级到 raw_content / snippet（本模块不处理）
 */

import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

export const MIN_BODY_CHARS = 200;

export interface ExtractedContent {
	text: string;
	title: string;
	strategy: "readability" | "plaintext";
}

/** 清洗正文文本：压缩多余空行与行内空白 */
export function cleanText(text: string): string {
	return text
		.replace(/[ \t]+/g, " ")
		.replace(/\n[ \t]+/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** 用 Readability 提取正文。失败（解析不出或正文过短）返回 undefined。 */
export function extractWithReadability(html: string, _url?: string): ExtractedContent | undefined {
	try {
		const { document } = parseHTML(html);
		const reader = new Readability(document as never, { charThreshold: MIN_BODY_CHARS });
		const article = reader.parse();
		if (!article || !article.textContent) return undefined;
		const text = cleanText(article.textContent);
		if (text.length < MIN_BODY_CHARS) return undefined;
		return { text, title: article.title ?? "", strategy: "readability" };
	} catch {
		return undefined;
	}
}

/** 纯文本提取（降级用）：剥除脚本/样式/导航后取 textContent。 */
export function extractPlaintext(html: string): ExtractedContent | undefined {
	try {
		const { document } = parseHTML(html);
		for (const selector of ["script", "style", "noscript", "template", "nav", "footer", "header", "form", "iframe"]) {
			for (const el of Array.from(document.querySelectorAll(selector))) {
				(el as { remove?: () => void }).remove?.();
			}
		}
		const title = document.title ?? "";
		const text = cleanText(document.body?.textContent ?? "");
		if (text.length < MIN_BODY_CHARS) return undefined;
		return { text, title, strategy: "plaintext" };
	} catch {
		return undefined;
	}
}

/** 降级链：readability → plaintext。都失败返回 undefined（调用方继续降级）。 */
export function extractBody(html: string, url: string): ExtractedContent | undefined {
	return extractWithReadability(html, url) ?? extractPlaintext(html);
}
