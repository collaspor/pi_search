/**
 * 事件重放与恢复（PRD §4.0.1 / §8.4 crash 策略，验收 A9）。
 *
 * 恢复规则：
 *   1. run.json 是权威快照
 *   2. 重放 events.jsonl 中 seq > run.lastSeq 的事件，把"快照之后
 *      发生的事"补齐进内存状态
 *   3. seq <= lastSeq 的事件一律丢弃（已并入快照）
 *   4. tool_call 事件的 argsHash 作为幂等键：重放时若某调用已有
 *      成功记录，上层直接复用缓存结果，不重复调外部 API
 *
 * 本模块只做"事件 → run 状态"的确定性归约，不做任何 IO 与 LLM 调用。
 */

import type { Evidence, ResearchEvent, ResearchRun, Source, Task } from "../types.ts";

export interface ReplayResult {
	/** 补齐后的 run（不修改原对象） */
	run: ResearchRun;
	/** 被应用的事件数 */
	applied: number;
	/** 被丢弃的事件数（seq <= lastSeq） */
	skipped: number;
	/** 已成功完成的工具调用幂等键集合（argsHash），供上层缓存复用 */
	succeededToolCalls: Set<string>;
	/** 首个 pending 状态的 task id，即 resume 的起点 */
	resumeFromTaskId?: string;
}

/** 把单个事件归约进 run 状态（原地修改，仅 replay 内部使用） */
function applyEvent(run: ResearchRun, event: ResearchEvent): void {
	switch (event.type) {
		case "phase_enter":
			run.status = event.phase;
			break;
		case "brief_ready":
			run.brief = event.brief;
			break;
		case "plan_ready":
			run.plan = event.plan;
			break;
		case "task_start": {
			const task = findTask(run, event.taskId);
			if (task) {
				task.status = "running";
				task.startedAt = event.ts;
			}
			break;
		}
		case "task_end": {
			const task = findTask(run, event.taskId);
			if (task) {
				task.status = event.status;
				task.finishedAt = event.ts;
				task.evidenceCount = event.evidenceCount;
			}
			break;
		}
		case "source_added":
			if (!run.sources.some((s) => s.id === event.source.id)) {
				run.sources.push(event.source as Source);
			}
			break;
		case "evidence_added":
			if (!run.evidence.some((e) => e.id === event.evidence.id)) {
				run.evidence.push(event.evidence as Evidence);
			}
			break;
		case "claims_ready":
			run.claims = event.claims;
			break;
		case "recovery":
			run.recoveries.push(event.event);
			break;
		case "budget_trip":
			run.budget.tripped = event.dimension;
			run.budget.usedTokens = event.usedTokens;
			run.budget.usedCostUsd = event.usedCostUsd;
			break;
		case "verification_done":
			run.verification = event.report;
			break;
		case "run_end":
			run.status = event.status;
			break;
		case "tool_call":
		case "blocked_url":
			// 仅用于审计与幂等判断，不改变 run 状态
			break;
	}
	run.updatedAt = event.ts;
}

function findTask(run: ResearchRun, taskId: string): Task | undefined {
	return run.plan?.tasks.find((t) => t.id === taskId);
}

/**
 * 重放事件流补齐 run 状态。
 * @param snapshot 从 run.json 读出的快照
 * @param events   events.jsonl 的全部事件
 */
export function replayEvents(snapshot: ResearchRun, events: ResearchEvent[]): ReplayResult {
	// 深拷贝快照，避免修改调用方对象
	const run: ResearchRun = JSON.parse(JSON.stringify(snapshot)) as ResearchRun;
	const lastSeq = snapshot.lastSeq;

	let applied = 0;
	let skipped = 0;
	const succeededToolCalls = new Set<string>();

	// 事件按 seq 排序防御乱序（正常写入是单调的，但文件可能被外部破坏）
	const sorted = [...events].sort((a, b) => a.seq - b.seq);

	for (const event of sorted) {
		if (event.type === "tool_call" && event.ok) {
			succeededToolCalls.add(event.argsHash);
		}
		if (event.seq <= lastSeq) {
			skipped++;
			continue;
		}
		applyEvent(run, event);
		applied++;
	}

	run.lastSeq = sorted.length > 0 ? Math.max(lastSeq, sorted[sorted.length - 1].seq) : lastSeq;

	const resumeFromTaskId = run.plan?.tasks.find((t) => t.status === "pending")?.id;

	return { run, applied, skipped, succeededToolCalls, resumeFromTaskId };
}
