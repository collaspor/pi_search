/**
 * 角色 LLM 调用封装（PRD §4 各角色的统一调用点）。
 *
 * 所有角色（Comprehender/Planner/Reporter/Verifier）的输出都通过
 * tool call 承载：模型拿到一个提交工具（如 submit_brief），其参数
 * 受 TypeBox schema 约束，从 AssistantMessage 的 toolCall 块中提取。
 *
 * 这比"prompt 要求输出 JSON"可靠：不会产生 markdown 围栏、注释、尾逗号。
 * 模型未调用工具时回灌一条明确指引重试（上限 1 次）。
 */

import type { AssistantMessage, Model, Tool, Usage } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";

/** 角色 LLM 调用的默认单次超时（90s）。可通过 RoleCallOptions.timeoutMs 覆盖。 */
export const DEFAULT_ROLE_TIMEOUT_MS = 90_000;

export interface RoleCallOptions {
	model: Model<any>;
	systemPrompt: string;
	userMessage: string;
	tool: Tool;
	/** 未调用工具时的重试上限，默认 1 */
	maxRetries?: number;
	apiKey?: string;
	/** OAuth 类 provider 的额外请求头 */
	headers?: Record<string, string>;
	signal?: AbortSignal;
	/** 单次 LLM 调用超时（默认 90s）。防止 provider 挂起导致 run 无限冻结。 */
	timeoutMs?: number;
}

export interface RoleCallOk {
	ok: true;
	args: Record<string, unknown>;
	usage: Usage;
	/** 是否经过了重试（用于 recovery 记录） */
	retried: boolean;
}

export interface RoleCallFail {
	ok: false;
	reason: string;
}

export type RoleCallResult = RoleCallOk | RoleCallFail;

/** 从 AssistantMessage 中提取指定工具的调用参数 */
export function extractToolArgs(message: AssistantMessage, toolName: string): Record<string, unknown> | undefined {
	for (const block of message.content) {
		if (block.type === "toolCall" && block.name === toolName) {
			if (typeof block.arguments === "object" && block.arguments !== null) {
				return block.arguments as Record<string, unknown>;
			}
			return {};
		}
	}
	return undefined;
}

const NUDGE =
	"You did not call the required tool. Respond ONLY by calling the tool as instructed. Do not output prose.";

export async function callRoleTool(options: RoleCallOptions): Promise<RoleCallResult> {
	const maxRetries = options.maxRetries ?? 1;
	const messages: { role: "user" | "assistant"; content: unknown }[] = [
		{ role: "user", content: options.userMessage },
	];

	// 单次调用超时兜底：provider 挂起时收敛到失败，走已有降级路径，而非无限冻结
	const timeoutMs = options.timeoutMs ?? DEFAULT_ROLE_TIMEOUT_MS;
	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		let message: AssistantMessage;
		try {
			message = await completeSimple(
				options.model,
				{
					systemPrompt: options.systemPrompt,
					messages: messages as never,
					tools: [options.tool],
				},
				{ apiKey: options.apiKey, headers: options.headers, signal } as never,
			);
		} catch (err) {
			return { ok: false, reason: `LLM call failed: ${err instanceof Error ? err.message : String(err)}` };
		}

		if (message.stopReason === "error" || message.stopReason === "aborted") {
			const isTimeout = timeoutSignal.aborted && !options.signal?.aborted;
			return {
				ok: false,
				reason: isTimeout
					? `LLM call timed out after ${timeoutMs}ms`
					: `LLM call ${message.stopReason}: ${message.errorMessage ?? ""}`,
			};
		}

		const args = extractToolArgs(message, options.tool.name);
		if (args !== undefined) {
			return { ok: true, args, usage: message.usage, retried: attempt > 0 };
		}

		// 模型没调工具：把它的回复和明确指引回灌，再试一次
		messages.push({ role: "assistant", content: message.content });
		messages.push({ role: "user", content: NUDGE });
	}

	return { ok: false, reason: `model did not call ${options.tool.name} after ${maxRetries + 1} attempts` };
}
