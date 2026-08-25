/**
 * Reporter（PRD §6.3 / §11.3）。
 *
 * 把已收集的 Evidence 组装为 Claims + Markdown 报告，submit_report 工具输出。
 *
 * 设计决策（调研结论，对 PRD §4 的有依据偏离）：
 *   PRD 给 Reporter 配 evidence_query 做增量检索（agent loop 模式），
 *   但 20~40 条 evidence 全量塞入单次 completeSimple 仅 8k~25k tokens，
 *   远低于 DeepSeek 的上下文窗口。全量塞入比增量检索更可靠——
 *   检索未召回会导致该写的证据没写进报告。故采用单次调用全量输入。
 *
 * 关键约束（§11.3）：
 *   - 无 search/fetch 工具，只能用下方提供的 evidence
 *   - 每个 claim 必须引用已存在的 evidence id（[^eN]）
 *   - 证据不足处必须明说，不得编造
 */

import type { Model, Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { Claim, Evidence, ResearchBrief, Source } from "../types.ts";
import { callRoleTool } from "./llm.ts";

export const REPORTER_SYSTEM_PROMPT = `You write a research report from ALREADY COLLECTED evidence. You have NO search or fetch tools — if evidence is missing, you say so explicitly in the report rather than inventing content.

Output protocol (MANDATORY):
- Output ONLY by calling the submit_report tool. Never output prose outside the tool.
- Every factual claim in the report MUST cite the evidence id it comes from, using inline footnote references like [^e12].
- Evidence ids follow the EXACT format shown in the evidence list (e.g. e1, e2, e12). Do NOT construct ids from task ids — [^T2e1] is INVALID and will be rejected. Only use ids verbatim from the provided list.
- Do NOT invent evidence ids. Only use ids from the provided evidence list.
- Do NOT write the footnote definition lines ([^e12]: ...) yourself — they are generated later by the system.
- claims[] must mirror the report: each entry has the claim text, the evidenceIds it cites (same ids as the [^eN] references), and the section it belongs to.

Report requirements:
- Follow the provided outline sections in order.
- Write in the same language as the user's original question.
- Distinguish clearly between what the evidence states (quote) and your interpretation.
- Where sources conflict, present both and cite each.
- Where a section has insufficient evidence, write a short honest note instead of fabricating.`;

const SUBMIT_REPORT_TOOL: Tool = {
	name: "submit_report",
	description: "Submit the research report (markdown body + structured claims). This is the only acceptable output.",
	parameters: Type.Object({
		markdown: Type.String({
			description: "Report body in markdown. Cite evidence inline as [^eN]. Do NOT write footnote definition lines.",
		}),
		claims: Type.Array(
			Type.Object({
				text: Type.String({ description: "One factual claim" }),
				evidenceIds: Type.Array(Type.String(), { description: "Evidence ids this claim cites (non-empty)" }),
				criterionIds: Type.Optional(Type.Array(Type.String())),
				section: Type.String({ description: "Outline section this claim belongs to" }),
			}),
		),
	}),
};

export interface ReportInput {
	brief: ResearchBrief;
	query: string;
	evidence: Evidence[];
	sources: Source[];
}

export interface ReportOptions {
	model: Model<any>;
	input: ReportInput;
	apiKey?: string;
	headers?: Record<string, string>;
	signal?: AbortSignal;
	/** L1 回灌修正时的错误清单（最多 1 轮） */
	previousErrors?: string[];
}

export interface ReportResult {
	ok: boolean;
	markdown?: string;
	claims?: Claim[];
	reason?: string;
}

/** 展示层截断（校验层仍用全文）：quote 400 / summary 300 */
function formatEvidenceForPrompt(evidence: Evidence[], sources: Source[]): string {
	const sourceById = new Map(sources.map((s) => [s.id, s]));
	return evidence
		.map((e) => {
			const source = sourceById.get(e.sourceId);
			const origin = source ? `${source.title || "(untitled)"} <${source.url}>` : e.sourceId;
			return [
				`[${e.id}] task=${e.taskId} stance=${e.stance} tier=${source?.tier ?? "?"}`,
				`  source: ${origin}`,
				`  quote: ${e.quote.slice(0, 400)}`,
				`  summary: ${e.summary.slice(0, 300)}`,
			].join("\n");
		})
		.join("\n\n");
}

function buildUserMessage(input: ReportInput, previousErrors?: string[]): string {
	const criteria = input.brief.successCriteria.map((sc) => `  ${sc.id} ${sc.text}`).join("\n");
	const parts = [
		`Research goal: ${input.brief.goal}`,
		`Original question: ${input.query}`,
		"",
		`Success criteria:\n${criteria}`,
		"",
		`Outline (follow in order):\n${input.brief.outline.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}`,
		"",
		`Evidence (${input.evidence.length} pieces):\n\n${formatEvidenceForPrompt(input.evidence, input.sources)}`,
	];
	if (previousErrors && previousErrors.length > 0) {
		parts.push(
			"",
			`Your previous report was REJECTED by structural validation for these reasons. Fix ALL of them without inventing new evidence ids:\n- ${previousErrors.join("\n- ")}`,
		);
	}
	return parts.join("\n");
}

interface RawClaim {
	text?: string;
	evidenceIds?: string[];
	criterionIds?: string[];
	section?: string;
}

export async function report(options: ReportOptions): Promise<ReportResult> {
	if (options.input.evidence.length === 0) {
		return { ok: false, reason: "no evidence collected — cannot produce a report with citations" };
	}

	const result = await callRoleTool({
		model: options.model,
		systemPrompt: REPORTER_SYSTEM_PROMPT,
		userMessage: buildUserMessage(options.input, options.previousErrors),
		tool: SUBMIT_REPORT_TOOL,
		apiKey: options.apiKey,
		headers: options.headers,
		signal: options.signal,
	});

	if (!result.ok) {
		return { ok: false, reason: result.reason };
	}

	const raw = result.args as { markdown?: string; claims?: RawClaim[] };
	if (typeof raw.markdown !== "string" || raw.markdown.trim() === "") {
		return { ok: false, reason: "submit_report returned empty markdown" };
	}
	if (!Array.isArray(raw.claims) || raw.claims.length === 0) {
		return { ok: false, reason: "submit_report returned no claims" };
	}

	const claims: Claim[] = raw.claims.map((rawClaim, index) => ({
		id: `c${index + 1}`,
		text: rawClaim.text ?? "",
		evidenceIds: Array.isArray(rawClaim.evidenceIds) ? rawClaim.evidenceIds : [],
		criterionIds: Array.isArray(rawClaim.criterionIds) ? rawClaim.criterionIds : [],
		section: rawClaim.section ?? "",
	}));

	return { ok: true, markdown: raw.markdown, claims };
}
