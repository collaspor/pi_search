/**
 * Planner（PRD §4.2，验收 A2）。
 *
 * 把 ResearchBrief 拆解为 4~8 个 Research Task，通过 submit_plan 工具输出。
 *
 * 覆盖度硬校验（代码层，非 LLM 判断）：
 *   union(tasks[].criterionIds) ⊇ brief.successCriteria[].id
 * 不满足则把缺失 criterion 回灌修正 1 次；仍不满足则为每个未覆盖
 * criterion 自动生成兜底 Task（query = criterion.text）。
 */

import type { Model, Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ResearchBrief, ResearchPlan, Task } from "../types.ts";
import { callRoleTool } from "./llm.ts";

export const PLANNER_SYSTEM_PROMPT = `You are a research planning specialist. Given a research brief, decompose it into concrete research tasks that can each be executed independently by web search and page fetching.

Rules:
- Output ONLY by calling the submit_plan tool. Never output prose.
- Produce 4 to 8 tasks.
- Each task needs: title (short), query (the initial web search query, specific and self-contained), rationale (why this task is necessary for the research goal), criterionIds (which successCriteria ids from the brief this task serves; every task must serve at least one).
- TOGETHER, the tasks must cover EVERY successCriterion id in the brief. This is mandatory.
- Tasks must be independently executable: do not assume one task's results are available to another.
- dependsOn: leave empty unless a task genuinely requires another task's output first.
- Write queries in whichever language is most likely to surface authoritative sources (often English for global topics, the user's language for local topics).
- Assign task ids T1, T2, ... in execution order.`;

const SUBMIT_PLAN_TOOL: Tool = {
	name: "submit_plan",
	description: "Submit the research plan. This is the only acceptable output.",
	parameters: Type.Object({
		tasks: Type.Array(
			Type.Object({
				id: Type.String({ description: "Task id: T1, T2, ..." }),
				title: Type.String(),
				query: Type.String({ description: "Initial web search query" }),
				rationale: Type.String({ description: "Why this task is necessary" }),
				criterionIds: Type.Array(Type.String(), {
					description: "SuccessCriteria ids this task serves (non-empty)",
				}),
				dependsOn: Type.Optional(Type.Array(Type.String())),
			}),
			{ description: "4-8 research tasks" },
		),
	}),
};

export interface PlanOptions {
	model: Model<any>;
	brief: ResearchBrief;
	maxTasks?: number;
	apiKey?: string;
	headers?: Record<string, string>;
	signal?: AbortSignal;
}

export interface PlanResult {
	plan: ResearchPlan;
	/** 未覆盖的 criterion 被兜底 Task 补齐时为 true */
	usedFallbackTasks: boolean;
}

/** 校验 Plan 是否满足代码层硬约束（A2），返回错误清单 */
export function validatePlan(brief: ResearchBrief, tasks: Task[]): string[] {
	const errors: string[] = [];
	if (tasks.length < 4 || tasks.length > 8) {
		errors.push(`task count must be 4-8, got ${tasks.length}`);
	}
	const scIds = new Set(brief.successCriteria.map((sc) => sc.id));
	const covered = new Set<string>();
	const taskIds = new Set<string>();
	for (const [i, task] of tasks.entries()) {
		if (typeof task.title !== "string" || task.title.trim() === "") errors.push(`tasks[${i}].title is empty`);
		if (typeof task.query !== "string" || task.query.trim() === "") errors.push(`tasks[${i}].query is empty`);
		if (typeof task.rationale !== "string" || task.rationale.trim() === "")
			errors.push(`tasks[${i}].rationale is empty`);
		if (!Array.isArray(task.criterionIds) || task.criterionIds.length === 0) {
			errors.push(`tasks[${i}].criterionIds is empty`);
			continue;
		}
		for (const id of task.criterionIds) {
			if (!scIds.has(id)) {
				errors.push(`tasks[${i}].criterionIds references unknown criterion "${id}"`);
			} else {
				covered.add(id);
			}
		}
		if (taskIds.has(task.id)) errors.push(`duplicate task id "${task.id}"`);
		taskIds.add(task.id);
	}
	for (const sc of brief.successCriteria) {
		if (!covered.has(sc.id)) {
			errors.push(`criterion ${sc.id} ("${sc.text}") is not covered by any task`);
		}
	}
	return errors;
}

interface RawTask {
	id?: string;
	title?: string;
	query?: string;
	rationale?: string;
	criterionIds?: string[];
	dependsOn?: string[];
}

function materializeTasks(rawTasks: RawTask[]): Task[] {
	return rawTasks.map((raw, index) => ({
		id: typeof raw.id === "string" && raw.id.trim() !== "" ? raw.id : `T${index + 1}`,
		title: raw.title ?? "",
		query: raw.query ?? "",
		rationale: raw.rationale ?? "",
		criterionIds: Array.isArray(raw.criterionIds) ? raw.criterionIds : [],
		dependsOn: Array.isArray(raw.dependsOn) ? raw.dependsOn : [],
		status: "pending",
		attempts: 0,
		evidenceCount: 0,
		minEvidence: 2,
	}));
}

/** 为未覆盖的 criterion 生成兜底 Task（PRD §4.2） */
function fallbackTasksFor(brief: ResearchBrief, uncoveredIds: string[], existingCount: number): Task[] {
	return uncoveredIds.map((criterionId, index) => {
		const criterion = brief.successCriteria.find((sc) => sc.id === criterionId);
		const text = criterion?.text ?? criterionId;
		return {
			id: `T${existingCount + index + 1}`,
			title: `Fallback: ${text.slice(0, 40)}`,
			query: text,
			rationale: `Auto-generated to cover success criterion ${criterionId}, which the plan missed.`,
			criterionIds: [criterionId],
			dependsOn: [],
			status: "pending",
			attempts: 0,
			evidenceCount: 0,
			minEvidence: 2,
		} satisfies Task;
	});
}

function buildUserMessage(brief: ResearchBrief, previousErrors?: string[]): string {
	const parts = [
		`Research brief:\n${JSON.stringify(brief, null, 2)}`,
		"Decompose this brief into research tasks now.",
	];
	if (previousErrors && previousErrors.length > 0) {
		parts.push(
			`Your previous plan was rejected for these reasons; fix all of them:\n- ${previousErrors.join("\n- ")}`,
		);
	}
	return parts.join("\n\n");
}

export async function plan(options: PlanOptions): Promise<PlanResult> {
	const maxTasks = options.maxTasks ?? 8;
	let previousErrors: string[] | undefined;

	for (let round = 0; round < 2; round++) {
		const result = await callRoleTool({
			model: options.model,
			systemPrompt: PLANNER_SYSTEM_PROMPT,
			userMessage: buildUserMessage(options.brief, previousErrors),
			tool: SUBMIT_PLAN_TOOL,
			apiKey: options.apiKey,
			headers: options.headers,
			signal: options.signal,
		});

		if (!result.ok) {
			previousErrors = [result.reason];
			continue;
		}

		const raw = result.args as { tasks?: RawTask[] };
		let tasks = materializeTasks(Array.isArray(raw.tasks) ? raw.tasks : []);
		if (tasks.length > maxTasks) tasks = tasks.slice(0, maxTasks);

		const errors = validatePlan(options.brief, tasks);
		if (errors.length === 0) {
			return { plan: { tasks, replanCount: round }, usedFallbackTasks: false };
		}

		// 第二轮：把剩余未覆盖项用兜底 Task 补齐（其他错误无法兜底，仍接受并记录）
		if (round === 1) {
			const scIds = new Set(options.brief.successCriteria.map((sc) => sc.id));
			const covered = new Set(tasks.flatMap((t) => t.criterionIds));
			const uncovered = [...scIds].filter((id) => !covered.has(id));
			if (uncovered.length > 0) {
				tasks = [...tasks, ...fallbackTasksFor(options.brief, uncovered, tasks.length)];
			}
			return { plan: { tasks, replanCount: round }, usedFallbackTasks: uncovered.length > 0 };
		}

		previousErrors = errors;
	}

	// 两轮 LLM 调用都失败：全部由兜底 Task 组成最小计划
	const allIds = options.brief.successCriteria.map((sc) => sc.id);
	return {
		plan: { tasks: fallbackTasksFor(options.brief, allIds, 0), replanCount: 1 },
		usedFallbackTasks: true,
	};
}
