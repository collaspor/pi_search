/**
 * Comprehender / Planner 角色契约测试（验收 A1/A2）。
 * 使用 pi 的 faux provider，确定性响应，无真实 LLM 调用。
 */

import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { comprehend, validateBrief } from "../src/roles/comprehender.ts";
import { plan, validatePlan } from "../src/roles/planner.ts";
import type { ResearchBrief, Task } from "../src/types.ts";

const registrations: { unregister: () => void }[] = [];

afterEach(() => {
	while (registrations.length > 0) registrations.pop()?.unregister();
});

function setupFaux() {
	const registration = registerFauxProvider({});
	registrations.push(registration);
	return registration;
}

const VALID_BRIEF: ResearchBrief = {
	goal: "梳理 2026 年 AI Agent 市场并比较三家厂商布局",
	scope: { included: ["市场规模", "产品布局"], excluded: ["股价"] },
	entities: ["OpenAI", "Anthropic", "Google"],
	successCriteria: [
		{ id: "SC1", text: "市场规模量化数据" },
		{ id: "SC2", text: "增长率与驱动因素" },
		{ id: "SC3", text: "三家产品线横向对比" },
	],
	assumptions: ["2026 年指自然年"],
	outline: ["市场概览", "厂商对比", "结论"],
};

function validPlanTasks(criterionIds: string[][] = [["SC1"], ["SC2"], ["SC3"], ["SC1", "SC2"]]): Task[] {
	return criterionIds.map((ids, i) => ({
		id: `T${i + 1}`,
		title: `任务 ${i + 1}`,
		query: `query ${i + 1}`,
		rationale: `理由 ${i + 1}`,
		criterionIds: ids,
		dependsOn: [],
		status: "pending" as const,
		attempts: 0,
		evidenceCount: 0,
		minEvidence: 2,
	}));
}

describe("comprehend（验收 A1）", () => {
	it("合法 Brief 直接通过", async () => {
		const faux = setupFaux();
		faux.setResponses([fauxAssistantMessage(fauxToolCall("submit_brief", VALID_BRIEF as never))]);

		const r = await comprehend({ model: faux.getModel(), query: "调研 2026 AI Agent 市场" });
		expect(r.degraded).toBe(false);
		expect(r.brief.successCriteria.length).toBeGreaterThanOrEqual(3);
		expect(r.brief.successCriteria.length).toBeLessThanOrEqual(7);
		expect(r.brief.goal.trim()).not.toBe("");
		expect(validateBrief(r.brief)).toEqual([]);
	});

	it("SC 数量不合格 → 回灌错误重试 → 第二次合格", async () => {
		const faux = setupFaux();
		const invalidBrief = { ...VALID_BRIEF, successCriteria: [{ id: "SC1", text: "只有一条" }] };
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("submit_brief", invalidBrief as never)),
			fauxAssistantMessage(fauxToolCall("submit_brief", VALID_BRIEF as never)),
		]);

		const r = await comprehend({ model: faux.getModel(), query: "q" });
		expect(r.degraded).toBe(false);
		expect(faux.state.callCount).toBe(2);
	});

	it("两次都不合格 → 降级 Brief，不抛异常", async () => {
		const faux = setupFaux();
		const invalidBrief = { ...VALID_BRIEF, goal: "   ", successCriteria: [] };
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("submit_brief", invalidBrief as never)),
			fauxAssistantMessage(fauxToolCall("submit_brief", invalidBrief as never)),
		]);

		const r = await comprehend({ model: faux.getModel(), query: "原始问题" });
		expect(r.degraded).toBe(true);
		expect(r.brief.goal).toBe("原始问题");
		expect(r.brief.successCriteria).toHaveLength(1);
	});

	it("模型不调工具 → nudge 重试后成功", async () => {
		const faux = setupFaux();
		faux.setResponses([
			fauxAssistantMessage(fauxText("我来分析一下……")),
			fauxAssistantMessage(fauxToolCall("submit_brief", VALID_BRIEF as never)),
		]);

		const r = await comprehend({ model: faux.getModel(), query: "q" });
		expect(r.degraded).toBe(false);
		expect(faux.state.callCount).toBe(2);
	});

	it("静态前缀与动态后缀结构：query 在 user message 中，协议在 system prompt 中", async () => {
		const faux = setupFaux();
		let seenSystem = "";
		let seenUser = "";
		faux.setResponses([
			(context) => {
				seenSystem = context.systemPrompt ?? "";
				const user = context.messages.find((m) => m.role === "user");
				seenUser = typeof user?.content === "string" ? user.content : "";
				return fauxAssistantMessage(fauxToolCall("submit_brief", VALID_BRIEF as never));
			},
		]);

		await comprehend({ model: faux.getModel(), query: "某研究问题XYZ" });
		expect(seenSystem).toContain("submit_brief");
		expect(seenSystem).toContain("successCriteria");
		expect(seenUser).toContain("某研究问题XYZ");
	});
});

describe("plan（验收 A2）", () => {
	it("合法 Plan 通过：rationale 非空且覆盖全部 SC", async () => {
		const faux = setupFaux();
		faux.setResponses([fauxAssistantMessage(fauxToolCall("submit_plan", { tasks: validPlanTasks() } as never))]);

		const r = await plan({ model: faux.getModel(), brief: VALID_BRIEF });
		expect(r.usedFallbackTasks).toBe(false);
		expect(r.plan.tasks).toHaveLength(4);
		for (const task of r.plan.tasks) {
			expect(task.rationale.trim()).not.toBe("");
			expect(task.status).toBe("pending");
			expect(task.minEvidence).toBe(2);
		}
		expect(validatePlan(VALID_BRIEF, r.plan.tasks)).toEqual([]);
	});

	it("覆盖度不足 → 回灌缺失项重试 → 第二次补齐", async () => {
		const faux = setupFaux();
		// 第一次：缺少 SC3 的任务
		const missing = validPlanTasks([["SC1"], ["SC2"], ["SC1"], ["SC2"]]);
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("submit_plan", { tasks: missing } as never)),
			fauxAssistantMessage(fauxToolCall("submit_plan", { tasks: validPlanTasks() } as never)),
		]);

		const r = await plan({ model: faux.getModel(), brief: VALID_BRIEF });
		expect(r.usedFallbackTasks).toBe(false);
		expect(r.plan.replanCount).toBe(1);
		expect(faux.state.callCount).toBe(2);
		expect(validatePlan(VALID_BRIEF, r.plan.tasks)).toEqual([]);
	});

	it("重试仍缺 → 未覆盖项用兜底 Task 补齐", async () => {
		const faux = setupFaux();
		const missing = validPlanTasks([["SC1"], ["SC2"], ["SC1"], ["SC2"]]);
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("submit_plan", { tasks: missing } as never)),
			fauxAssistantMessage(fauxToolCall("submit_plan", { tasks: missing } as never)),
		]);

		const r = await plan({ model: faux.getModel(), brief: VALID_BRIEF });
		expect(r.usedFallbackTasks).toBe(true);
		// SC3 被兜底 Task 覆盖
		const fallbackTask = r.plan.tasks.find((t) => t.criterionIds.includes("SC3"));
		expect(fallbackTask).toBeDefined();
		expect(fallbackTask?.query).toContain("三家产品线横向对比");
		// 兜底后覆盖度通过
		const covered = new Set(r.plan.tasks.flatMap((t) => t.criterionIds));
		expect(covered.has("SC1") && covered.has("SC2") && covered.has("SC3")).toBe(true);
	});

	it("criterionIds 引用未知 SC 被拒", () => {
		const tasks = [
			{
				id: "T1",
				title: "t",
				query: "q",
				rationale: "r",
				criterionIds: ["SC99"],
				dependsOn: [],
				status: "pending" as const,
				attempts: 0,
				evidenceCount: 0,
				minEvidence: 2,
			},
			...validPlanTasks()
				.slice(0, 3)
				.map((t) => ({ ...t, id: `X${t.id}` })),
		];
		const errors = validatePlan(VALID_BRIEF, tasks);
		expect(errors.some((e) => e.includes("SC99"))).toBe(true);
	});

	it("重复 task id 被拒", () => {
		const tasks = validPlanTasks().map((t) => ({ ...t, id: "T1" }));
		const errors = validatePlan(VALID_BRIEF, tasks);
		expect(errors.some((e) => e.includes("duplicate task id"))).toBe(true);
	});

	it("两轮 LLM 都失败 → 全兜底最小计划，不抛异常", async () => {
		const faux = setupFaux();
		faux.setResponses([
			fauxAssistantMessage(fauxText("我不知道怎么规划")),
			fauxAssistantMessage(fauxText("还是不知道")),
			fauxAssistantMessage(fauxText("第三次也不知道")),
			fauxAssistantMessage(fauxText("第四次也不知道")),
		]);

		const r = await plan({ model: faux.getModel(), brief: VALID_BRIEF });
		expect(r.usedFallbackTasks).toBe(true);
		expect(r.plan.tasks.length).toBe(VALID_BRIEF.successCriteria.length);
	});
});
