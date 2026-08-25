/**
 * L1 结构校验（PRD §7.1，验收 A5）。
 *
 * 纯代码、0 token。六条检查：
 *   1. 悬空引用：报告 [^eN] 全部存在于 run.evidence
 *   2. 无引用 Claim：每个 Claim evidenceIds 非空且都存在
 *   3. 证据不可追溯：每条被引用 Evidence 的 quote 能在 sources/<id>.txt 定位
 *   4. Criterion 覆盖：血缘反推（coverage.ts，不信自报标签）
 *   5. 引用格式：每个正文引用都有对应脚注定义（渲染后由代码保证）
 *   6. fuzzy 独撑：无 Claim 仅由 fuzzy 证据支撑（告警）
 *   7. 未使用证据：收集但未引用（告警）
 *
 * 阻断处理与终止保证（§7.1 评审修正）：
 *   budget.tripped → 跳过回灌修正，直接剔除 → partial
 *   否则 → 错误清单回灌 Reporter 修 1 次（硬上限）→ 再校验
 *     通过 → completed；仍不通过 → 确定性剔除 → 空则 failed 落存根，否则 partial
 */

import type { CheckpointStore } from "../orchestrator/checkpoint.ts";
import { extractCitationIds, extractFootnoteDefIds } from "../report/markdown.ts";
import type { L1Verification, ResearchRun } from "../types.ts";
import { computeCoverage } from "../verify/coverage.ts";
import { locateQuote } from "../verify/quote-locator.ts";

export interface L1Context {
	run: ResearchRun;
	store: CheckpointStore;
	/** 渲染后的最终报告（含代码生成的脚注定义） */
	renderedMarkdown: string;
	fuzzyThreshold?: number;
}

export async function verifyL1(context: L1Context): Promise<L1Verification> {
	const { run, store, renderedMarkdown } = context;
	const evidenceIds = new Set(run.evidence.map((e) => e.id));
	const evidenceById = new Map(run.evidence.map((e) => [e.id, e]));

	// 1. 悬空引用
	const citedIds = [...new Set(extractCitationIds(renderedMarkdown))];
	const danglingCitations = citedIds.filter((id) => !evidenceIds.has(id));

	// 2. 无引用 Claim
	const unsupportedClaims = run.claims
		.filter((claim) => claim.evidenceIds.length === 0 || claim.evidenceIds.some((id) => !evidenceIds.has(id)))
		.map((claim) => claim.id);

	// 3. 证据不可追溯（只检查被引用的证据，未引用的在告警里）
	const citedEvidenceIds = new Set(run.claims.flatMap((c) => c.evidenceIds));
	const untraceableEvidence: string[] = [];
	for (const evidenceId of citedEvidenceIds) {
		const evidence = evidenceById.get(evidenceId);
		if (!evidence) continue;
		const body = await store.readSourceBody(evidence.sourceId);
		if (body === undefined) {
			untraceableEvidence.push(evidenceId);
			continue;
		}
		const located = locateQuote(body, evidence.quote, { fuzzyThreshold: context.fuzzyThreshold });
		if (!located.found) untraceableEvidence.push(evidenceId);
	}

	// 4. Criterion 覆盖（血缘反推）
	const brief = run.brief;
	const coverageResult = brief
		? computeCoverage(brief.successCriteria, run.plan?.tasks ?? [], run.evidence, run.claims)
		: { coverage: [], uncoveredCriteria: [], passed: true };

	// 5. 引用格式：正文引用都有脚注定义
	const definedIds = new Set(extractFootnoteDefIds(renderedMarkdown));
	const missingDefinitions = citedIds.filter((id) => evidenceIds.has(id) && !definedIds.has(id));

	// 6. fuzzy 独撑（告警）：claim 的全部证据都是 fuzzy 级
	const fuzzySoleSupport = run.claims
		.filter((claim) => {
			if (claim.evidenceIds.length === 0) return false;
			return claim.evidenceIds.every((id) => evidenceById.get(id)?.quoteMatch === "fuzzy");
		})
		.map((claim) => claim.id);

	// 7. 未使用证据（告警）
	const unusedEvidence = run.evidence.filter((e) => !citedEvidenceIds.has(e.id)).map((e) => e.id);

	const blocking =
		danglingCitations.length > 0 ||
		unsupportedClaims.length > 0 ||
		untraceableEvidence.length > 0 ||
		coverageResult.uncoveredCriteria.length > 0 ||
		missingDefinitions.length > 0;

	return {
		danglingCitations,
		unsupportedClaims,
		untraceableEvidence,
		unusedEvidence,
		fuzzySoleSupport,
		coverage: coverageResult.coverage,
		uncoveredCriteria: coverageResult.uncoveredCriteria,
		passed: !blocking,
	};
}

/** 把 L1 失败原因转成回灌 Reporter 的错误清单 */
export function l1ErrorMessages(l1: L1Verification): string[] {
	const messages: string[] = [];
	if (l1.danglingCitations.length > 0) {
		messages.push(
			`Dangling citations (referenced ids that do NOT exist in evidence): ${l1.danglingCitations.join(", ")}. Remove these references or replace them with existing evidence ids.`,
		);
	}
	if (l1.unsupportedClaims.length > 0) {
		messages.push(
			`Claims without valid evidence: ${l1.unsupportedClaims.join(", ")}. Every claim must cite at least one existing evidence id.`,
		);
	}
	if (l1.untraceableEvidence.length > 0) {
		messages.push(
			`Evidence whose quote cannot be located in its source: ${l1.untraceableEvidence.join(", ")}. Do not cite these; use other evidence.`,
		);
	}
	if (l1.uncoveredCriteria.length > 0) {
		messages.push(
			`Success criteria with NO supporting claim (via task→evidence→claim lineage): ${l1.uncoveredCriteria.join(", ")}. Add claims citing the evidence those tasks collected.`,
		);
	}
	return messages;
}
