/**
 * evidence_record 工具（PRD §5.3，验收 A4）。
 *
 * 这是 Evidence-first 的执行点：模型摘录证据时调用，quote 必须能在该
 * Source 正文中定位（M2 的三级定位），否则拒收并要求重新摘录。
 * 定位失败的 quote 不计入 task.evidenceCount。
 */

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { Evidence, EvidenceStance } from "../types.ts";
import { locateQuote } from "../verify/quote-locator.ts";
import type { ToolEnv } from "./env.ts";

interface RecordDetails {
	ok: boolean;
	evidenceId?: string;
	quoteMatch?: Evidence["quoteMatch"];
	reason?: string;
	taskEvidenceCount: number;
}

const RecordParams = Type.Object({
	sourceId: Type.String({ description: "Source id from web_search/web_fetch, e.g. s3" }),
	quote: Type.String({ description: "VERBATIM excerpt from the source. Do NOT paraphrase." }),
	summary: Type.String({ description: "Your interpretation of what this quote shows for the research task" }),
	stance: Type.Union([Type.Literal("support"), Type.Literal("refute"), Type.Literal("neutral")], {
		description: "Whether this evidence supports, refutes, or is neutral to the task's working assumption",
	}),
});

export function createEvidenceRecordTool(env: ToolEnv): AgentTool<typeof RecordParams, RecordDetails> {
	return {
		name: "evidence_record",
		label: "Record Evidence",
		description:
			"Record a piece of evidence from a fetched source. quote MUST be a verbatim excerpt from that source's content — it is verified against the stored page text and rejected if it cannot be located. Put your interpretation in summary, never in quote.",
		parameters: RecordParams,

		async execute(_toolCallId, params): Promise<AgentToolResult<RecordDetails>> {
			const task = env.currentTask;
			const sourceId = String(params.sourceId ?? "");
			const quote = String(params.quote ?? "");
			const summary = String(params.summary ?? "");
			const stance = String(params.stance ?? "neutral") as EvidenceStance;

			const fail = (reason: string): AgentToolResult<RecordDetails> => ({
				content: [
					{
						type: "text" as const,
						text: `Evidence REJECTED: ${reason}\nRe-read the source content and call evidence_record again with the exact verbatim quote copied from it.`,
					},
				],
				details: { ok: false, reason, taskEvidenceCount: task?.evidenceCount ?? 0 },
			});

			if (!task) return fail("no active research task");
			const source = env.run.sources.find((s) => s.id === sourceId);
			if (!source) return fail(`unknown sourceId "${sourceId}" — use an id returned by web_search/web_fetch`);
			const body = await env.store.readSourceBody(source.id);
			if (body === undefined) return fail(`source ${sourceId} has no stored content`);

			const located = locateQuote(body, quote);
			if (!located.found) {
				const recoveryEvent = {
					ts: Date.now(),
					level: "task" as const,
					taskId: task.id,
					failureType: "quote_unverifiable" as const,
					strategy: "reject_and_request_requote",
					attempt: 1,
					outcome: "degraded" as const,
					detail: located.reason,
				};
				env.run.recoveries.push(recoveryEvent);
				await env.store.appendEvent({ type: "recovery", event: recoveryEvent });
				// M6：同 Task 连续 2 次拒收后，指引换来源而非纠缠
				const guidance = env.failureTracker?.onQuoteRejected(task.id, sourceId);
				return fail(
					`quote could not be located in ${sourceId}: ${located.reason}${guidance ? `\n${guidance.hint}` : ""}`,
				);
			}
			env.failureTracker?.onQuoteAccepted(task.id);

			const evidence: Evidence = {
				id: `e${env.seq.evidence++}`,
				taskId: task.id,
				sourceId: source.id,
				quote,
				summary,
				locator: { start: located.start, end: located.end },
				stance,
				quoteMatch: located.level,
				matchScore: located.matchScore,
				createdAt: Date.now(),
			};
			env.run.evidence.push(evidence);
			task.evidenceCount++;
			await env.store.appendEvent({ type: "evidence_added", evidence });

			return {
				content: [
					{
						type: "text" as const,
						text: `Evidence recorded as ${evidence.id} (${located.level} match in ${source.id}). Task ${task.id} now has ${task.evidenceCount}/${task.minEvidence} pieces of evidence.`,
					},
				],
				details: {
					ok: true,
					evidenceId: evidence.id,
					quoteMatch: located.level,
					taskEvidenceCount: task.evidenceCount,
				},
			};
		},
	};
}
