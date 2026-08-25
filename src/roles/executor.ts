/**
 * Executor（PRD §4.3）。
 *
 * 每个 Task 是一次独立的 pi Agent Loop（runAgentLoop），独立上下文，
 * 工具集 = [web_search, web_fetch, evidence_record]（AgentContext.tools
 * per-run 隔离，这是 §4.3 工具作用域的实现依据）。
 *
 * 终止条件挂 shouldStopAfterTurn（agent-loop.ts:247），契约要求
 * "must not throw"（types.ts:220）——判定逻辑整体兜底，出错返回 true
 * （停止），由 Task 出口状态接手，符合 §8.1 收敛原则。
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { runAgentLoop } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { UNTRUSTED_ANCHOR } from "../net/untrusted.ts";
import type { ToolEnv } from "../tools/env.ts";
import { createEvidenceRecordTool } from "../tools/evidence-record.ts";
import { createWebFetchTool } from "../tools/web-fetch.ts";
import { createWebSearchTool } from "../tools/web-search.ts";
import type { Task } from "../types.ts";

export const MAX_TURNS_PER_TASK = 8;

export function buildExecutorSystemPrompt(): string {
	return `You are a research executor working on ONE research task.

Evidence protocol (MANDATORY):
- Every fact you report MUST come from evidence_record.
- quote must be VERBATIM text copied from the source. Never paraphrase inside quote.
- Put your interpretation in summary, never in quote.
- If a quote is rejected, re-read the source and copy the exact text.

Workflow:
1. web_search with your task query (adjust keywords if results are poor)
2. web_fetch the most promising 2-4 results (prefer official / primary sources)
3. evidence_record for each relevant finding
4. Stop when you have enough evidence, or report that you could not find it.

Never fabricate. "Not found" is an acceptable and valuable answer.

${UNTRUSTED_ANCHOR}`;
}

/** Executor 单轮 LLM 调用的默认超时（120s）。可通过 ExecuteTaskOptions.llmTimeoutMs 覆盖。 */
export const DEFAULT_LLM_TIMEOUT_MS = 120_000;

export interface ExecuteTaskOptions {
	model: Model<any>;
	apiKey?: string;
	headers?: Record<string, string>;
	signal?: AbortSignal;
	maxTurns?: number;
	/** 单轮 LLM 调用超时（默认 120s） */
	llmTimeoutMs?: number;
	onToolEvent?: (text: string) => void;
}

export interface TaskOutcome {
	status: "success" | "failed" | "unresolved";
	/** success 但 evidenceCount < minEvidence 时为 true（降级成功） */
	degraded: boolean;
	turns: number;
	usedTokens: number;
	usedCostUsd: number;
	error?: string;
}

function buildTaskMessage(task: Task, goal: string): string {
	return [
		`Research goal: ${goal}`,
		"",
		`Your task (${task.id}): ${task.title}`,
		`Description / rationale: ${task.rationale}`,
		`Initial search query: ${task.query}`,
		"",
		`Collect at least ${task.minEvidence} pieces of evidence via evidence_record. Begin now.`,
	].join("\n");
}

export async function executeTask(env: ToolEnv, task: Task, options: ExecuteTaskOptions): Promise<TaskOutcome> {
	const maxTurns = options.maxTurns ?? MAX_TURNS_PER_TASK;
	// 每个 Task 独立 env 视图（评审修复：不写共享 env.currentTask，
	// concurrency > 1 时并发 Task 不会互相覆盖证据归属）。
	// 序号自增与 appendEvent 的 seq 分配均为同步代码，单线程下并发安全。
	const taskEnv: ToolEnv = { ...env, currentTask: task };

	let turns = 0;
	const goal = env.run.brief?.goal ?? env.run.query;
	const promptMessage: AgentMessage = {
		role: "user",
		content: buildTaskMessage(task, goal),
		timestamp: Date.now(),
	};

	const tools = [createWebSearchTool(taskEnv), createWebFetchTool(taskEnv), createEvidenceRecordTool(taskEnv)];

	// 契约：must not throw or reject（types.ts:220）。出错返回 true（停止）。
	const shouldStopAfterTurn = async (): Promise<boolean> => {
		try {
			turns++;
			if (task.evidenceCount >= task.minEvidence) return true;
			if (turns >= maxTurns) return true;
			if (env.run.budget.tripped !== undefined) return true;
			return false;
		} catch (err) {
			await env.store.appendEvent({
				type: "recovery",
				event: {
					ts: Date.now(),
					level: "task",
					taskId: task.id,
					failureType: "task_exception",
					strategy: "stop_guard_failed",
					attempt: 1,
					outcome: "degraded",
					detail: err instanceof Error ? err.message : String(err),
				},
			});
			return true;
		}
	};

	// 单轮 LLM 调用超时兜底：防止 provider 挂起导致 Task 无限冻结（M6 修复）
	const timeoutMs = options.llmTimeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
	const llmTimeoutSignal = AbortSignal.timeout(timeoutMs);
	const callSignal = options.signal ? AbortSignal.any([options.signal, llmTimeoutSignal]) : llmTimeoutSignal;

	try {
		const newMessages = await runAgentLoop(
			[promptMessage],
			{ systemPrompt: buildExecutorSystemPrompt(), messages: [], tools },
			{
				model: options.model,
				convertToLlm: (messages: AgentMessage[]) => messages as never,
				apiKey: options.apiKey,
				headers: options.headers,
				signal: callSignal,
				timeoutMs,
				shouldStopAfterTurn,
			} as never,
			async () => {},
			callSignal,
			streamSimple as never,
		);

		// 累计该 Task 的 token / 成本
		let usedTokens = 0;
		let usedCostUsd = 0;
		for (const message of newMessages) {
			if (message.role === "assistant" && "usage" in message && message.usage) {
				usedTokens += message.usage.totalTokens ?? 0;
				usedCostUsd += message.usage.cost?.total ?? 0;
			}
		}
		env.run.budget.usedTokens += usedTokens;
		env.run.budget.usedCostUsd += usedCostUsd;

		// loop 正常返回不代表成功：末条 assistant 消息 stopReason 为 error/aborted 时，
		// runLoop 会优雅退出（agent-loop.ts:196-200）而不抛异常，必须显式判 failed
		const lastAssistant = [...newMessages].reverse().find((m) => m.role === "assistant");
		if (lastAssistant && "stopReason" in lastAssistant) {
			const stopReason = lastAssistant.stopReason;
			if (stopReason === "error" || stopReason === "aborted") {
				const errorMessage = "errorMessage" in lastAssistant ? String(lastAssistant.errorMessage ?? "") : "";
				return {
					status: "failed",
					degraded: false,
					turns,
					usedTokens,
					usedCostUsd,
					error: errorMessage || stopReason,
				};
			}
		}

		const degraded = task.evidenceCount >= 1 && task.evidenceCount < task.minEvidence;
		const status = task.evidenceCount >= 1 ? "success" : "unresolved";
		return { status, degraded, turns, usedTokens, usedCostUsd };
	} catch (err) {
		return {
			status: "failed",
			degraded: false,
			turns,
			usedTokens: 0,
			usedCostUsd: 0,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}
