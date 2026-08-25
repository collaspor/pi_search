/**
 * L2 语义校验（PRD §7.2）。
 *
 * 对每个 Claim 用独立 LLM 调用判定 supported/unsupported/conflicting/uncertain。
 *
 * 关键设计：上下文隔离——只给 Claim 文本 + 检索到的 Evidence，
 * 不给 Reporter 的推理过程，否则模型会倾向认同已有论证（橡皮图章）。
 *
 * 残余失效模式（§7.2 评审，如实呈现不假装根治）：
 *   同模型同源偏差 / 措辞牵引 / 检索共谋 / 判定偷懒。
 * 缓解：
 *   - 强制输出 citedEvidenceIds 作为判定依据
 *   - 额外检索 stance=refute 的反面证据（对抗检索共谋）
 *   - 全部判 supported 时调用方标注"校验结果可信度存疑"
 */

import type { Model, Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { Claim, Evidence, L2ClaimVerdict, Source } from "../types.ts";
import { callRoleTool } from "./llm.ts";

export const VERIFIER_SYSTEM_PROMPT = `You are an independent fact-checker. You are given ONE claim and a set of evidence excerpts. Judge whether the evidence actually supports the claim.

Critical rules:
- Output ONLY by calling the submit_verdict tool. Never output prose.
- Base your verdict STRICTLY on the provided evidence quotes. Ignore the claim's tone or confidence.
- citedEvidenceIds is MANDATORY: list the evidence ids you actually relied on. An empty list with a "supported" verdict is invalid.
- verdict values:
  - supported: the evidence directly and specifically backs the claim
  - unsupported: no evidence backs the claim, or the evidence is about something else
  - conflicting: two or more evidence excerpts materially disagree about the claim
  - uncertain: evidence is related but too vague/indirect to confirm or refute
- A claim about numbers/dates is only "supported" if the numbers/dates match the evidence EXACTLY.`;

const SUBMIT_VERDICT_TOOL: Tool = {
	name: "submit_verdict",
	description: "Submit the verification verdict for the claim. This is the only acceptable output.",
	parameters: Type.Object({
		verdict: Type.Union(
			[
				Type.Literal("supported"),
				Type.Literal("unsupported"),
				Type.Literal("conflicting"),
				Type.Literal("uncertain"),
			],
			{ description: "Your judgment" },
		),
		reason: Type.String({ description: "One sentence explaining the verdict, citing specifics" }),
		citedEvidenceIds: Type.Array(Type.String(), {
			description: "Evidence ids you relied on (mandatory for supported)",
		}),
	}),
};

export interface VerifyL2Options {
	model: Model<any>;
	claims: Claim[];
	evidence: Evidence[];
	sources: Source[];
	apiKey?: string;
	headers?: Record<string, string>;
	signal?: AbortSignal;
	onProgress?: (text: string) => void;
}

/** 检索与 claim 相关的证据（含反面证据，对抗检索共谋） */
function retrieveForClaim(claim: Claim, evidence: Evidence[]): Evidence[] {
	const byId = new Map(evidence.map((e) => [e.id, e]));
	const own = claim.evidenceIds.map((id) => byId.get(id)).filter((e): e is Evidence => e !== undefined);
	// 同 task 的其他证据 + refute 立场的证据
	const taskIds = new Set(own.map((e) => e.taskId));
	const related = evidence.filter((e) => taskIds.has(e.taskId) && !claim.evidenceIds.includes(e.id));
	const refuting = evidence.filter((e) => e.stance === "refute" && !claim.evidenceIds.includes(e.id));
	const merged = [...own, ...related, ...refuting];
	// 去重 + 限量（防止单 claim 上下文过大）
	const seen = new Set<string>();
	return merged
		.filter((e) => {
			if (seen.has(e.id)) return false;
			seen.add(e.id);
			return true;
		})
		.slice(0, 20);
}

function formatEvidence(e: Evidence, sources: Source[]): string {
	const source = sources.find((s) => s.id === e.sourceId);
	const origin = source ? `${source.title || "(untitled)"} <${source.url}>` : e.sourceId;
	return `[${e.id}] (stance: ${e.stance}, tier: ${source?.tier ?? "?"})\n  source: ${origin}\n  quote: ${e.quote.slice(0, 400)}\n  summary: ${e.summary.slice(0, 200)}`;
}

export async function verifyL2(options: VerifyL2Options): Promise<L2ClaimVerdict[]> {
	const verdicts: L2ClaimVerdict[] = [];
	for (const claim of options.claims) {
		const pool = retrieveForClaim(claim, options.evidence);
		if (pool.length === 0) {
			verdicts.push({
				claimId: claim.id,
				verdict: "unsupported",
				reason: "No evidence available for this claim",
				citedEvidenceIds: [],
			});
			continue;
		}
		const userMessage = [
			`Claim (${claim.id}): ${claim.text}`,
			"",
			`Evidence (${pool.length} excerpts):\n\n${pool.map((e) => formatEvidence(e, options.sources)).join("\n\n")}`,
		].join("\n");

		const result = await callRoleTool({
			model: options.model,
			systemPrompt: VERIFIER_SYSTEM_PROMPT,
			userMessage,
			tool: SUBMIT_VERDICT_TOOL,
			apiKey: options.apiKey,
			headers: options.headers,
			signal: options.signal,
		});

		if (result.ok) {
			const args = result.args as {
				verdict?: L2ClaimVerdict["verdict"];
				reason?: string;
				citedEvidenceIds?: string[];
			};
			verdicts.push({
				claimId: claim.id,
				verdict: args.verdict ?? "uncertain",
				reason: args.reason ?? "",
				citedEvidenceIds: Array.isArray(args.citedEvidenceIds) ? args.citedEvidenceIds : [],
			});
		} else {
			verdicts.push({
				claimId: claim.id,
				verdict: "uncertain",
				reason: `verification call failed: ${result.reason}`,
				citedEvidenceIds: [],
			});
		}
		options.onProgress?.(`  ${claim.id} → ${verdicts[verdicts.length - 1].verdict}`);
	}
	return verdicts;
}

/** 全 supported 判定（§7.2：橡皮图章信号，调用方据此标注可信度存疑） */
export function isAllSupported(verdicts: L2ClaimVerdict[]): boolean {
	return verdicts.length > 0 && verdicts.every((v) => v.verdict === "supported");
}
