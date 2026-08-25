/**
 * evidence_query 工具（PRD §5.4）。
 *
 * 供 Reporter 与 Verifier 检索已收集证据（这两个角色没有 search/fetch
 * 工具，防止边写边搜绕过 Evidence 层）。V1 检索实现：BM25-lite 关键词打分。
 */

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { Evidence } from "../types.ts";
import type { ToolEnv } from "./env.ts";

const STOP_WORDS = new Set([
	"the",
	"a",
	"an",
	"of",
	"in",
	"on",
	"for",
	"to",
	"and",
	"or",
	"is",
	"are",
	"was",
	"were",
	"by",
	"with",
	"as",
	"at",
	"的",
	"了",
	"在",
	"是",
	"和",
	"与",
	"对",
	"为",
	"以",
	"及",
	"或",
	"其",
	"中",
]);

export function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

/** BM25-lite 打分：词频 × 逆文档频率 */
export function scoreEvidence(
	evidence: Evidence,
	queryTokens: string[],
	df: Map<string, number>,
	totalDocs: number,
): number {
	if (queryTokens.length === 0) return 0;
	const docText = `${evidence.quote} ${evidence.summary}`;
	const docTokens = tokenize(docText);
	if (docTokens.length === 0) return 0;
	const tf = new Map<string, number>();
	for (const t of docTokens) tf.set(t, (tf.get(t) ?? 0) + 1);
	let score = 0;
	for (const qt of queryTokens) {
		const freq = tf.get(qt) ?? 0;
		if (freq === 0) continue;
		const docFreq = df.get(qt) ?? 0;
		const idf = Math.log(1 + (totalDocs - docFreq + 0.5) / (docFreq + 0.5));
		score += (freq * idf) / (freq + 1.2);
	}
	return score;
}

interface QueryDetails {
	ok: boolean;
	matchCount: number;
	evidenceIds: string[];
}

const QueryParams = Type.Object({
	keywords: Type.Optional(Type.Array(Type.String(), { description: "Keywords to match against quote+summary" })),
	taskId: Type.Optional(Type.String({ description: "Restrict to evidence from one task" })),
	criterionId: Type.Optional(
		Type.String({ description: "Restrict to evidence serving one success criterion (via its tasks)" }),
	),
	stance: Type.Optional(Type.Union([Type.Literal("support"), Type.Literal("refute"), Type.Literal("neutral")])),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, description: "Max results, default 20" })),
});

export function createEvidenceQueryTool(env: ToolEnv): AgentTool<typeof QueryParams, QueryDetails> {
	return {
		name: "evidence_query",
		label: "Query Evidence",
		description:
			"Search the evidence already collected in this research run. Returns matching evidence with ids (e12), quotes, summaries and source info. This is the ONLY way to access evidence — you cannot search the web.",
		parameters: QueryParams,

		async execute(_toolCallId, params): Promise<AgentToolResult<QueryDetails>> {
			const keywords = params.keywords ? params.keywords.map(String) : [];
			const limit = params.limit ?? 20;

			let pool = env.run.evidence;
			if (typeof params.taskId === "string") {
				pool = pool.filter((e) => e.taskId === params.taskId);
			}
			if (typeof params.criterionId === "string") {
				const taskIds = new Set(
					(env.run.plan?.tasks ?? [])
						.filter((t) => t.criterionIds.includes(params.criterionId as string))
						.map((t) => t.id),
				);
				pool = pool.filter((e) => taskIds.has(e.taskId));
			}
			if (typeof params.stance === "string") {
				pool = pool.filter((e) => e.stance === params.stance);
			}

			const queryTokens = keywords.flatMap(tokenize);
			const df = new Map<string, number>();
			for (const e of pool) {
				for (const t of new Set(tokenize(`${e.quote} ${e.summary}`))) {
					df.set(t, (df.get(t) ?? 0) + 1);
				}
			}

			const scored = pool
				.map((e) => ({ e, score: queryTokens.length > 0 ? scoreEvidence(e, queryTokens, df, pool.length) : 1 }))
				.filter((s) => s.score > 0)
				.sort((a, b) => b.score - a.score)
				.slice(0, limit);

			const text =
				scored.length === 0
					? "No evidence matched. Try different keywords or broader filters."
					: scored
							.map(({ e }) => {
								const source = env.run.sources.find((s) => s.id === e.sourceId);
								return [
									`[${e.id}] (task ${e.taskId}, source ${e.sourceId}${source ? ` ${source.url}` : ""}, stance: ${e.stance})`,
									`  quote: ${e.quote.slice(0, 400)}`,
									`  summary: ${e.summary.slice(0, 300)}`,
								].join("\n");
							})
							.join("\n\n");

			return {
				content: [{ type: "text" as const, text }],
				details: { ok: true, matchCount: scored.length, evidenceIds: scored.map((s) => s.e.id) },
			};
		},
	};
}
