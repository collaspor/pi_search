/**
 * 超时收敛测试（修复验证）：LLM 调用挂起时收敛到降级结局，而非无限冻结。
 * 用 faux provider 挂起响应 + 极短超时，断言收敛。
 */

import type { Tool } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { comprehend } from "../src/roles/comprehender.ts";
import { callRoleTool, DEFAULT_ROLE_TIMEOUT_MS } from "../src/roles/llm.ts";
import type { ResearchBrief } from "../src/types.ts";

const registrations: { unregister: () => void }[] = [];

afterEach(() => {
	while (registrations.length > 0) registrations.pop()?.unregister();
});

function setupFaux() {
	const r = registerFauxProvider({});
	registrations.push(r);
	return r;
}

const VALID_BRIEF: ResearchBrief = {
	goal: "目标",
	scope: { included: [], excluded: [] },
	entities: [],
	successCriteria: [
		{ id: "SC1", text: "判据一" },
		{ id: "SC2", text: "判据二" },
		{ id: "SC3", text: "判据三" },
	],
	assumptions: [],
	outline: ["章节一", "章节二"],
};

describe("callRoleTool 超时收敛", () => {
	it("LLM 响应流极慢 + 短超时 → 信号触发 abort，收敛不冻结", async () => {
		// 极慢流：长文本 + 1 token/秒，流式循环中 signal 检查会触发 abort
		const faux = registerFauxProvider({ tokensPerSecond: 1 });
		registrations.push(faux);
		faux.setResponses([fauxAssistantMessage("x".repeat(500))]);

		const tool: Tool = { name: "submit_x", description: "x", parameters: Type.Object({}) };
		const start = Date.now();
		const result = await callRoleTool({
			model: faux.getModel(),
			systemPrompt: "sys",
			userMessage: "user",
			tool,
			timeoutMs: 200, // 极短超时
		});
		const elapsed = Date.now() - start;

		// 关键断言：在远小于流完 500 token（500 秒）的时间内收敛
		expect(result.ok).toBe(false);
		expect(elapsed).toBeLessThan(5000);
		// it 超时 15s：faux 每 chunk 3~5 token、1 token/s → 首个 chunk 的
		// setTimeout（3~5s）不可中断，收敛耗时逼近 vitest 默认 5s 上限（flaky）
	}, 15000);

	it("默认超时是 90s", () => {
		expect(DEFAULT_ROLE_TIMEOUT_MS).toBe(90_000);
	});

	it("正常快速响应 → 不受超时影响", async () => {
		const faux = setupFaux();
		faux.setResponses([fauxAssistantMessage(fauxToolCall("submit_brief", VALID_BRIEF as never))]);

		const result = await comprehend({ model: faux.getModel(), query: "q" });
		expect(result.degraded).toBe(false);
		expect(result.brief.goal).toBe("目标");
	});
});
