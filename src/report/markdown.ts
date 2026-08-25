/**
 * 报告渲染（PRD §6.3 / §7.1）。
 *
 * 两条正则分工：
 *   - FOOTNOTE_DEF_RE：脚注定义行（行首 ≤3 空格 + 标签 + 冒号）
 *   - CITATION_RE：正文引用（负向断言排除定义行标签与转义形式）
 *
 * 关键原则：脚注定义行全部由代码生成，不信 LLM（防定义行内容造假）。
 * Source.title 来自互联网，渲染前必须 escapeMarkdown。
 */

import { escapeMarkdown } from "../net/untrusted.ts";
import type { Source } from "../types.ts";

/** 脚注定义行：行首（允许 ≤3 空格缩进）+ 标签 + 冒号 */
export const FOOTNOTE_DEF_RE = /^ {0,3}\[\^(e\d+)\]:[ \t]/gm;

/** 正文引用：排除转义的 \[^e12] 与定义行标签（后跟冒号） */
export const CITATION_RE = /(?<!\\)\[\^(e\d+)\](?!\s*:)/g;

/** 提取正文中的全部引用 id（含重复） */
export function extractCitationIds(markdown: string): string[] {
	const ids: string[] = [];
	for (const match of markdown.matchAll(CITATION_RE)) {
		ids.push(match[1]);
	}
	return ids;
}

/** 提取脚注定义行中的全部 id */
export function extractFootnoteDefIds(markdown: string): string[] {
	const ids: string[] = [];
	for (const match of markdown.matchAll(FOOTNOTE_DEF_RE)) {
		ids.push(match[1]);
	}
	return ids;
}

/** 删除全部脚注定义行（剔除后由代码重建） */
export function stripFootnoteDefinitions(markdown: string): string {
	return markdown
		.split("\n")
		.filter((line) => !/^ {0,3}\[\^e\d+\]:[ \t]/.test(line))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trimEnd();
}

function formatFootnoteDefinition(evidenceId: string, sourcesByEvidence: Map<string, Source>): string {
	const source = sourcesByEvidence.get(evidenceId);
	if (!source) return `[^${evidenceId}]: (source unavailable)`;
	const title = escapeMarkdown(source.title || "(untitled)");
	const parts = [`[^${evidenceId}]: [${title}](${source.url})`];
	const meta: string[] = [];
	if (source.publishedAt) meta.push(`发布于 ${source.publishedAt}`);
	meta.push(`检索于 ${new Date(source.retrievedAt).toISOString().slice(0, 10)}`);
	return `${parts[0]} — ${meta.join("，")}`;
}

/**
 * 渲染最终报告：剥离 LLM 可能自写的定义行，按正文引用顺序重建。
 * 返回正文中被引用但不在 evidenceIds 里的 id（供 L1 判 dangling）。
 */
export function renderReport(
	markdown: string,
	evidenceIds: Set<string>,
	sourcesByEvidence: Map<string, Source>,
): { markdown: string; citedIds: string[]; danglingIds: string[] } {
	const body = stripFootnoteDefinitions(markdown);
	const citedIds = [...new Set(extractCitationIds(body))];
	const danglingIds = citedIds.filter((id) => !evidenceIds.has(id));

	const definitions = citedIds
		.filter((id) => evidenceIds.has(id))
		.map((id) => formatFootnoteDefinition(id, sourcesByEvidence));

	const finalMarkdown = definitions.length > 0 ? `${body}\n\n---\n\n${definitions.join("\n")}\n` : `${body}\n`;
	return { markdown: finalMarkdown, citedIds, danglingIds };
}

// ============================================================================
// 按空行块剔除（PRD §7.1 评审修正：不按标题不按行）
// ============================================================================

/** 按空行把报告切块（段落/列表/代码块/标题都以空行分隔） */
export function splitBlocks(markdown: string): string[] {
	return markdown.split(/\n{2,}/).filter((b) => b.trim() !== "");
}

function blockCitations(block: string): string[] {
	return extractCitationIds(block);
}

function isHeadingBlock(block: string): boolean {
	return /^\s*#{1,6}\s/.test(block);
}

/**
 * 句级剔除：删除含违规引用的句子，保留其余。
 * 中文句末标点（。！？）后直接切；英文（.!?）后需空白/换行才切，
 * 避免把 "e.g." 或数字小数点当句末。
 */
function removeSentencesWithIds(block: string, violatingIds: Set<string>): string {
	const sentences = block.split(/(?<=[。！？])|(?<=[.!?])\s+|\n/);
	const kept = sentences.filter((sentence) => {
		if (!sentence || sentence.trim() === "") return false;
		const ids = blockCitations(sentence);
		return !ids.some((id) => violatingIds.has(id));
	});
	return kept.join("").trim();
}

/**
 * 按块剔除违规引用（确定性操作，PRD §7.1）。
 *
 * 规则：
 *   - 标题块永不删除（章节骨架保留）
 *   - 整块只含违规引用 → 删整块
 *   - 混合块 → 句级剔除只删违规句；剔除后为空 → 删整块
 */
export function removeViolatingCitations(markdown: string, violatingIds: Set<string>): string {
	if (violatingIds.size === 0) return markdown;
	const body = stripFootnoteDefinitions(markdown);
	const blocks = splitBlocks(body);
	const kept: string[] = [];

	for (const block of blocks) {
		if (isHeadingBlock(block)) {
			kept.push(block);
			continue;
		}
		const ids = blockCitations(block);
		const hasViolation = ids.some((id) => violatingIds.has(id));
		if (!hasViolation) {
			kept.push(block);
			continue;
		}
		const hasCleanCitation = ids.some((id) => !violatingIds.has(id));
		if (!hasCleanCitation && ids.length > 0) {
			// 整块存在的唯一依据是违规 claim → 删整块
			continue;
		}
		const trimmed = removeSentencesWithIds(block, violatingIds);
		if (trimmed !== "" && blockCitations(trimmed).every((id) => !violatingIds.has(id))) {
			kept.push(trimmed);
		}
	}

	return kept.join("\n\n");
}
