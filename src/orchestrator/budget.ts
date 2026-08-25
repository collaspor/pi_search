/**
 * Budget 三维熔断（PRD §4.6 / §8.4，评审修复）。
 *
 * 评审发现：tripped 全代码库无人设置，maxTokens/maxCostUsd/maxWallClockMs
 * 形同虚设。本模块是唯一的熔断判定与发事件点。
 *
 * 检查时机：
 *   - 每个 Task 结束后（run.ts 循环）
 *   - Executor 的 shouldStopAfterTurn 读 run.budget.tripped（已就位）
 *
 * 前置门禁（§8.4，进入 reporting 前必须过）：
 *   !brief            → failed + 存根（不调 Reporter）
 *   evidence 为空     → failed + 存根（不调 Reporter）
 *   budget.tripped    → 正常 Reporter，但跳过 L1 回灌修正轮、跳过 L2
 */

import type { BudgetDimension, ResearchRun } from "../types.ts";
import type { CheckpointStore } from "./checkpoint.ts";

/** 检查三维预算，首次越限时设置 tripped 并发 budget_trip 事件。返回越限维度（未越限为 undefined）。 */
export async function checkBudgetTrip(
	run: ResearchRun,
	store: CheckpointStore,
	now = Date.now(),
): Promise<BudgetDimension | undefined> {
	if (run.budget.tripped !== undefined) return run.budget.tripped;

	let dimension: BudgetDimension | undefined;
	if (run.budget.usedTokens >= run.budget.maxTokens) dimension = "tokens";
	else if (run.budget.usedCostUsd >= run.budget.maxCostUsd) dimension = "cost";
	else if (now - run.budget.startedAt >= run.budget.maxWallClockMs) dimension = "time";

	if (dimension === undefined) return undefined;

	run.budget.tripped = dimension;
	run.recoveries.push({
		ts: now,
		level: "run",
		failureType: "budget_exceeded",
		strategy: "trip_breaker",
		attempt: 1,
		outcome: "degraded",
		detail: `预算维度 ${dimension} 越限（tokens=${run.budget.usedTokens}/${run.budget.maxTokens}, cost=$${run.budget.usedCostUsd.toFixed(4)}/$${run.budget.maxCostUsd}, elapsed=${Math.round((now - run.budget.startedAt) / 1000)}s）`,
	});
	await store.appendEvent({
		type: "budget_trip",
		dimension,
		usedTokens: run.budget.usedTokens,
		usedCostUsd: run.budget.usedCostUsd,
	});
	await store.appendEvent({ type: "recovery", event: run.recoveries[run.recoveries.length - 1] });
	return dimension;
}

// ============================================================================
// 进入 reporting 的前置门禁（§8.4 评审修正 P0-2）
// ============================================================================

export type ReportingGate =
	| { action: "proceed" } // 正常 reporting → verifying
	| { action: "proceed_degraded" } // 已熔断：Reporter 照跑，但跳过 L1 修正轮与 L2
	| { action: "failed_stub"; reason: string }; // 无 brief / 零证据：failed + 存根

export function reportingGate(run: ResearchRun): ReportingGate {
	if (!run.brief) {
		return { action: "failed_stub", reason: "预算在目标理解阶段耗尽，未产出研究简报" };
	}
	if (run.evidence.length === 0) {
		return { action: "failed_stub", reason: "未收集到任何证据，无法生成带引用的报告" };
	}
	if (run.budget.tripped !== undefined) {
		return { action: "proceed_degraded" };
	}
	return { action: "proceed" };
}
