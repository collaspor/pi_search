/**
 * successCriteria 覆盖度计算（PRD §4.1 / §7.1，验收 A5）。
 *
 * 判据来自血缘链反推，不信 Reporter 自报标签：
 *
 *   SC 被覆盖 ⟺ ∃ task:    SC.id ∈ task.criterionIds
 *               ∧ ∃ evidence: evidence.taskId === task.id
 *               ∧ ∃ claim:   evidence.id ∈ claim.evidenceIds
 *
 * 链上每一环都不由 Reporter 自由决定：
 *   Task.criterionIds   Planner 填，经 Planner 覆盖度硬校验
 *   Evidence.taskId     evidence_record 工具落库时写入
 *   Claim.evidenceIds   L1 校验存在性（引用不存在的 id 判 dangling）
 *
 * 这是评审 P0-3 的修正：自报的 Claim.criterionIds 仅用于展示，
 * 不参与覆盖度判定。
 */

import type { Claim, Criterion, Evidence, Task } from "../types.ts";

export interface CoverageResult {
	/** 每个 SC 的覆盖情况 */
	coverage: { criterionId: string; claimCount: number }[];
	/** 未被覆盖的 SC id */
	uncoveredCriteria: string[];
	/** 全部覆盖为 true */
	passed: boolean;
}

export function computeCoverage(
	criteria: Criterion[],
	tasks: Task[],
	evidence: Evidence[],
	claims: Claim[],
): CoverageResult {
	// evidence.id → taskId（仅限血缘，不经过任何模型自报字段）
	const evidenceTask = new Map<string, string>();
	for (const ev of evidence) {
		evidenceTask.set(ev.id, ev.taskId);
	}

	// claim 实际引用到的 taskId 集合（经 evidence 反推）
	const referencedTaskIds = new Set<string>();
	for (const claim of claims) {
		for (const evId of claim.evidenceIds) {
			const taskId = evidenceTask.get(evId);
			if (taskId !== undefined) referencedTaskIds.add(taskId);
		}
	}

	// taskId → 该 task 绑定的 criterionIds
	const taskCriteria = new Map<string, string[]>();
	for (const task of tasks) {
		taskCriteria.set(task.id, task.criterionIds);
	}

	const coverage = criteria.map((criterion) => {
		// 收集绑定该 SC 的 task 产出的、且被 claim 引用的 evidence 数量
		let claimCount = 0;
		for (const taskId of referencedTaskIds) {
			if (taskCriteria.get(taskId)?.includes(criterion.id)) {
				// 该 task 绑定了此 SC 且其证据被引用
				claimCount++;
			}
		}
		return { criterionId: criterion.id, claimCount };
	});

	const uncoveredCriteria = coverage.filter((c) => c.claimCount === 0).map((c) => c.criterionId);

	return {
		coverage,
		uncoveredCriteria,
		passed: uncoveredCriteria.length === 0,
	};
}
