/**
 * 三层失败策略路由（PRD §8，M6 核心）。
 *
 * 工具层（web_search / web_fetch）只做两件事：记录失败 + 向本模块要指引。
 * 策略全部集中在这里，工具不含任何恢复逻辑——这是"失败必须有终点"
 * 能成立的前提：每条链的上限都由本模块的硬计数控制，不依赖模型判断。
 *
 * L2 Task 级策略（§8.3）：
 *   no_search_result      → Query Rewrite 策略池（≤3，每次换不同策略）
 *   all_fetch_failed      → 引导扩大结果集重搜（top5→top10，1 次）
 *   quote_unverifiable    → 拒收；同 Task 连续 2 次后禁止再纠缠该来源
 *   insufficient_evidence → 补充子 Task（1 次）→ minEvidence 降为 1 → unresolved
 *   task_exception        → 重跑 Task（1 次）→ failed
 *
 * L3 Run 级（§8.4）：
 *   repeated_task_failure（≥30%）→ Re-plan（1 次）→ 带现有证据结报
 */

import type { RecoveryEvent, Task } from "../types.ts";

// ============================================================================
// Query Rewrite 策略池（§8.3）——必须每次换不同策略，而非随机重写
// ============================================================================

export interface RewriteStrategy {
	id: string;
	instruction: string;
}

export const REWRITE_STRATEGIES: RewriteStrategy[] = [
	{
		id: "simplify_terms",
		instruction: "把专业术语换成更通俗的表达（例如 LLM agent orchestration → AI 智能体 任务编排）",
	},
	{ id: "switch_language", instruction: "切换查询语言（中文 ↔ 英文），目标站点多为英文就用英文查" },
	{ id: "decompose", instruction: "把查询拆成更小的子问题，只查其中一个最具体的点" },
	{ id: "relax_scope", instruction: "放宽限定条件：去掉年份、地域或厂商限定，扩大命中范围" },
];

export const MAX_REWRITE_ATTEMPTS = 3;

// ============================================================================
// FailureTracker：每个 Task 的失败计数与恢复指引（工具层的唯一依赖）
// ============================================================================

export interface FailureGuidance {
	/** 给模型的指引文本（直接拼进工具返回的 content） */
	hint: string;
	/** 是否还有恢复余地；false 表示该换方向或收尾，不要再试同类操作 */
	exhausted: boolean;
}

interface TaskFailureState {
	noResultCount: number;
	fetchFailureCount: number;
	quoteRejectCount: number;
	widenedOnce: boolean;
}

export class FailureTracker {
	private readonly states = new Map<string, TaskFailureState>();

	private state(taskId: string): TaskFailureState {
		let s = this.states.get(taskId);
		if (!s) {
			s = { noResultCount: 0, fetchFailureCount: 0, quoteRejectCount: 0, widenedOnce: false };
			this.states.set(taskId, s);
		}
		return s;
	}

	/** 搜索无结果：按策略池顺序给下一条改写指引；用完即止 */
	onSearchNoResult(taskId: string, originalQuery: string): FailureGuidance {
		const s = this.state(taskId);
		if (s.noResultCount >= MAX_REWRITE_ATTEMPTS) {
			return {
				hint: `Query rewriting is exhausted (${MAX_REWRITE_ATTEMPTS} attempts). Do NOT search the same topic again. Work with whatever you already have, or honestly conclude the information could not be found.`,
				exhausted: true,
			};
		}
		const strategy = REWRITE_STRATEGIES[s.noResultCount];
		s.noResultCount++;
		return {
			hint: `0 results for "${originalQuery}" (rewrite attempt ${s.noResultCount}/${MAX_REWRITE_ATTEMPTS}, strategy: ${strategy.id}). ${strategy.instruction}. Call web_search ONCE more with the rewritten query.`,
			exhausted: false,
		};
	}

	/** 搜索成功：重置该 Task 的 no-result 计数 */
	onSearchSuccess(taskId: string): void {
		this.state(taskId).noResultCount = 0;
	}

	/** 抓取失败（未降级）：累计；≥2 次引导扩量重搜一次 */
	onFetchFailure(taskId: string): FailureGuidance {
		const s = this.state(taskId);
		s.fetchFailureCount++;
		if (s.fetchFailureCount >= 2 && !s.widenedOnce) {
			s.widenedOnce = true;
			return {
				hint: "Multiple pages failed to fetch. Do ONE more web_search with maxResults=10 to widen the candidate pool, then fetch the 2-3 most authoritative results (prefer official/primary sources).",
				exhausted: false,
			};
		}
		if (s.fetchFailureCount >= 2) {
			return {
				hint: "Pages keep failing. Stop fetching new URLs for this topic; rely on search snippets you already have, or move on.",
				exhausted: true,
			};
		}
		return {
			hint: "This page failed. Try the next result from your search list, or use its snippet.",
			exhausted: false,
		};
	}

	/** quote 定位被拒：同 Task 连续 2 次后禁止再纠缠同一来源 */
	onQuoteRejected(taskId: string, sourceId: string): FailureGuidance {
		const s = this.state(taskId);
		s.quoteRejectCount++;
		if (s.quoteRejectCount >= 2) {
			return {
				hint: `Your quotes were rejected ${s.quoteRejectCount} times. STOP trying to quote from ${sourceId}. Either fetch a DIFFERENT source, or use the snippet content of sources you already have.`,
				exhausted: true,
			};
		}
		return {
			hint: "Quote rejected. Re-read the source content above and copy the EXACT verbatim text (numbers must match exactly).",
			exhausted: false,
		};
	}

	onQuoteAccepted(taskId: string): void {
		this.state(taskId).quoteRejectCount = 0;
	}
}

// ============================================================================
// Task 级恢复包装（run.ts 调用）：task_exception 重跑 + insufficient 补充子任务
// ============================================================================

export type ExecuteTaskFn = (
	task: Task,
	opts?: { queryOverride?: string },
) => Promise<{
	status: "success" | "failed" | "unresolved";
	degraded: boolean;
	error?: string;
}>;

export interface TaskRecoveryDeps {
	executeTask: ExecuteTaskFn;
	recordRecovery: (
		event: Omit<RecoveryEvent, "ts" | "level" | "taskId"> & { level?: "task" | "run"; taskId?: string },
	) => Promise<void>;
}

/**
 * 带 Task 级恢复的 executeTask 包装：
 *   failed → 重跑 1 次
 *   证据 1..min-1 → 生成 1 个补充子任务（换角度）再跑 1 次；
 *     合并证据后仍不足 → minEvidence 降为 1 按降级成功计
 *   证据 0 → unresolved（不重跑，没意义）
 */
export async function runTaskWithRecovery(
	task: Task,
	deps: TaskRecoveryDeps,
): Promise<{ status: Task["status"]; degraded: boolean; error?: string }> {
	let outcome = await deps.executeTask(task);

	// task_exception → 重跑 1 次
	if (outcome.status === "failed") {
		await deps.recordRecovery({
			level: "task",
			taskId: task.id,
			failureType: "task_exception",
			strategy: "rerun_task",
			attempt: 1,
			outcome: "degraded",
			detail: outcome.error ?? "unknown",
		});
		outcome = await deps.executeTask(task);
		if (outcome.status !== "failed") {
			await deps.recordRecovery({
				level: "task",
				taskId: task.id,
				failureType: "task_exception",
				strategy: "rerun_task",
				attempt: 2,
				outcome: "recovered",
				detail: "重跑后恢复",
			});
		}
	}

	// insufficient_evidence → 补充子任务 1 次
	if (task.evidenceCount >= 1 && task.evidenceCount < task.minEvidence) {
		const supplementQuery = `${task.query}（换个角度：找官方数据、原始报告或第一手来源）`;
		await deps.recordRecovery({
			level: "task",
			taskId: task.id,
			failureType: "insufficient_evidence",
			strategy: "supplementary_subtask",
			attempt: 1,
			outcome: "degraded",
			detail: `证据 ${task.evidenceCount}/${task.minEvidence}，生成补充子任务`,
		});
		const before = task.evidenceCount;
		const supplement = await deps.executeTask(task, { queryOverride: supplementQuery });
		if (task.evidenceCount > before) {
			await deps.recordRecovery({
				level: "task",
				taskId: task.id,
				failureType: "insufficient_evidence",
				strategy: "supplementary_subtask",
				attempt: 1,
				outcome: "recovered",
				detail: `补充后证据 ${task.evidenceCount} 条`,
			});
		}
		if (task.evidenceCount < task.minEvidence) {
			// 仍不足：minEvidence 降为 1，按降级成功计
			task.minEvidence = 1;
		}
		if (supplement.status === "failed" && outcome.status !== "failed") {
			outcome = { ...outcome, degraded: true };
		}
	}

	if (task.evidenceCount >= task.minEvidence) {
		return { status: "success", degraded: task.minEvidence <= 1 || outcome.degraded };
	}
	if (task.evidenceCount >= 1) {
		return { status: "success", degraded: true };
	}
	return { status: outcome.status === "failed" ? "failed" : "unresolved", degraded: false, error: outcome.error };
}

// ============================================================================
// L3 Run 级：repeated_task_failure → Re-plan（1 次）
// ============================================================================

export const REPLAN_FAILURE_RATIO = 0.3;

/** 是否触发 Re-plan：失败+未解决任务占比 ≥30% 且未重规划过 */
export function shouldReplan(tasks: Task[], replanCount: number): boolean {
	if (replanCount >= 1) return false;
	if (tasks.length === 0) return false;
	const failed = tasks.filter((t) => t.status === "failed" || t.status === "unresolved").length;
	return failed / tasks.length >= REPLAN_FAILURE_RATIO;
}
