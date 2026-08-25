/**
 * Comprehender（PRD §4.1，验收 A1）。
 *
 * 把用户的开放式问题固化为 ResearchBrief，其中 successCriteria 是
 * 后续覆盖度校验的判据来源。通过 submit_brief 工具输出。
 *
 * Prompt 结构（§11.1）：静态前缀（角色定义+输出协议）+ 动态后缀（用户问题）。
 * 约束校验失败时回灌错误清单重试 1 次，仍失败则用降级 Brief 继续。
 */

import type { Model, Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ResearchBrief } from "../types.ts";
import { callRoleTool } from "./llm.ts";

export const COMPREHENDER_SYSTEM_PROMPT = `You are a research comprehension specialist. Your job is to convert an open-ended research question into a precise research brief BEFORE any searching happens.

Rules:
- Output ONLY by calling the submit_brief tool. Never output prose.
- goal: one sentence stating the research objective.
- scope.included / scope.excluded: what the research must and must not cover.
- entities: the concrete organizations, products, or people the question is about.
- timeRange: fill only when the question implies a time scope; use ISO dates (YYYY-MM or YYYY-MM-DD).
- successCriteria: 3 to 7 falsifiable criteria that together define "this research answered the question well". Each must be concrete enough to verify later (e.g. "Provide quantitative market size data for 2026", not "Analyze the market"). Assign ids SC1, SC2, ...
- assumptions: state every assumption you make when the question is ambiguous.
- outline: 3 to 6 report section titles the final report should follow.
- Write in the same language as the user's question.`;

const SUBMIT_BRIEF_TOOL: Tool = {
	name: "submit_brief",
	description: "Submit the research brief. This is the only acceptable output.",
	parameters: Type.Object({
		goal: Type.String({ description: "One-sentence research objective" }),
		scope: Type.Object({
			included: Type.Array(Type.String()),
			excluded: Type.Array(Type.String()),
		}),
		entities: Type.Array(Type.String()),
		timeRange: Type.Optional(
			Type.Object({
				from: Type.Optional(Type.String()),
				to: Type.Optional(Type.String()),
			}),
		),
		successCriteria: Type.Array(Type.Object({ id: Type.String(), text: Type.String() }), {
			description: "3-7 falsifiable criteria, ids SC1..SCn",
		}),
		assumptions: Type.Array(Type.String()),
		outline: Type.Array(Type.String(), { description: "3-6 report section titles" }),
	}),
};

export interface ComprehendOptions {
	model: Model<any>;
	query: string;
	/** 用户修正意见（确认环节输入，最多 1 轮） */
	revision?: string;
	apiKey?: string;
	headers?: Record<string, string>;
	signal?: AbortSignal;
}

export interface ComprehendResult {
	brief: ResearchBrief;
	/** true 表示模型两次输出都不合格，使用了降级 Brief */
	degraded: boolean;
}

/** 校验 Brief 是否满足代码层硬约束（A1） */
export function validateBrief(brief: ResearchBrief): string[] {
	const errors: string[] = [];
	if (typeof brief.goal !== "string" || brief.goal.trim() === "") {
		errors.push("goal is empty");
	}
	const scCount = brief.successCriteria?.length ?? 0;
	if (scCount < 3 || scCount > 7) {
		errors.push(`successCriteria must have 3-7 items, got ${scCount}`);
	}
	for (const [i, sc] of (brief.successCriteria ?? []).entries()) {
		if (typeof sc.id !== "string" || sc.id.trim() === "") errors.push(`successCriteria[${i}].id is empty`);
		if (typeof sc.text !== "string" || sc.text.trim() === "") errors.push(`successCriteria[${i}].text is empty`);
	}
	if (!Array.isArray(brief.outline) || brief.outline.length < 2) {
		errors.push("outline must have at least 2 sections");
	}
	if (!brief.scope || !Array.isArray(brief.scope.included) || !Array.isArray(brief.scope.excluded)) {
		errors.push("scope.included/excluded must be arrays");
	}
	return errors;
}

function fallbackBrief(query: string): ResearchBrief {
	return {
		goal: query,
		scope: { included: [query], excluded: [] },
		entities: [],
		successCriteria: [{ id: "SC1", text: `Answer the question: ${query}` }],
		assumptions: ["Brief generation degraded: fell back to a single-criterion brief."],
		outline: ["Findings", "Conclusion"],
	};
}

function buildUserMessage(query: string, revision?: string, previousErrors?: string[]): string {
	const parts = [`Research question:\n${query}`];
	if (revision) {
		parts.push(`User revision (must be incorporated):\n${revision}`);
	}
	if (previousErrors && previousErrors.length > 0) {
		parts.push(
			`Your previous brief was rejected for these reasons; fix all of them:\n- ${previousErrors.join("\n- ")}`,
		);
	}
	return parts.join("\n\n");
}

export async function comprehend(options: ComprehendOptions): Promise<ComprehendResult> {
	const attempts: { revision?: string; previousErrors?: string[] }[] = [{ revision: options.revision }];

	for (let round = 0; round < 2; round++) {
		const attempt = attempts[round];
		const result = await callRoleTool({
			model: options.model,
			systemPrompt: COMPREHENDER_SYSTEM_PROMPT,
			userMessage: buildUserMessage(options.query, attempt.revision, attempt.previousErrors),
			tool: SUBMIT_BRIEF_TOOL,
			apiKey: options.apiKey,
			headers: options.headers,
			signal: options.signal,
		});

		if (result.ok) {
			const brief = result.args as unknown as ResearchBrief;
			const errors = validateBrief(brief);
			if (errors.length === 0) {
				return { brief, degraded: false };
			}
			attempts.push({ revision: options.revision, previousErrors: errors });
			continue;
		}
		// LLM 调用本身失败（含未调工具），不值得再试同样的输入
		attempts.push({ revision: options.revision, previousErrors: [result.reason] });
	}

	return { brief: fallbackBrief(options.query), degraded: true };
}
