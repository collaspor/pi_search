/**
 * M6 测试：Budget 三维熔断 + reporting 门禁 + FailureTracker 策略池 + runTaskWithRecovery + Re-plan 判定。
 * 全部纯逻辑，无网络无 LLM。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkBudgetTrip, compensateBudgetIdleGap, reportingGate } from "../src/orchestrator/budget.ts";
import { CheckpointStore } from "../src/orchestrator/checkpoint.ts";
import {
	FailureTracker,
	MAX_REWRITE_ATTEMPTS,
	REWRITE_STRATEGIES,
	runTaskWithRecovery,
	shouldReplan,
} from "../src/orchestrator/failure-policy.ts";
import type { ResearchRun, Task } from "../src/types.ts";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "pi-research-budget-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function makeRun(overrides?: Partial<ResearchRun>): ResearchRun {
	return {
		id: "run-1",
		query: "q",
		status: "researching",
		createdAt: 0,
		updatedAt: 0,
		schemaVersion: 1,
		sources: [],
		evidence: [],
		claims: [],
		budget: {
			maxTokens: 1000,
			maxCostUsd: 0.5,
			maxWallClockMs: 5000,
			maxTasks: 8,
			maxFetchPerTask: 5,
			usedTokens: 0,
			usedCostUsd: 0,
			startedAt: Date.now(),
		},
		recoveries: [],
		lastSeq: 0,
		...overrides,
	};
}

function makeTask(id: string, status: Task["status"] = "pending", evidenceCount = 0, minEvidence = 2): Task {
	return {
		id,
		title: id,
		query: "q",
		rationale: "r",
		criterionIds: [],
		dependsOn: [],
		status,
		attempts: 0,
		evidenceCount,
		minEvidence,
	};
}

describe("checkBudgetTrip 三维熔断", () => {
	it("tokens 越限 → tripped=tokens + budget_trip 事件", async () => {
		const run = makeRun();
		run.budget.usedTokens = 1000;
		const store = await CheckpointStore.create(dir, run.id);
		const d = await checkBudgetTrip(run, store);
		expect(d).toBe("tokens");
		expect(run.budget.tripped).toBe("tokens");
		expect(run.recoveries.some((r) => r.failureType === "budget_exceeded")).toBe(true);
	});

	it("cost 越限 → tripped=cost", async () => {
		const run = makeRun();
		run.budget.usedCostUsd = 0.5;
		const store = await CheckpointStore.create(dir, run.id);
		expect(await checkBudgetTrip(run, store)).toBe("cost");
	});

	it("time 越限 → tripped=time", async () => {
		const run = makeRun();
		run.budget.startedAt = Date.now() - 10000;
		const store = await CheckpointStore.create(dir, run.id);
		expect(await checkBudgetTrip(run, store)).toBe("time");
	});

	it("未越限 → undefined，不设 tripped", async () => {
		const run = makeRun();
		const store = await CheckpointStore.create(dir, run.id);
		expect(await checkBudgetTrip(run, store)).toBeUndefined();
		expect(run.budget.tripped).toBeUndefined();
	});

	it("已 tripped → 幂等，不重复发事件", async () => {
		const run = makeRun();
		run.budget.usedTokens = 1000;
		const store = await CheckpointStore.create(dir, run.id);
		await checkBudgetTrip(run, store);
		const count = run.recoveries.length;
		await checkBudgetTrip(run, store);
		expect(run.recoveries.length).toBe(count);
	});
});

describe("compensateBudgetIdleGap — resume 时 wall-clock 预算顺延（A9 回归）", () => {
	it("崩溃中断时长顺延 startedAt，避免 time 维度误判熔断", () => {
		// 场景还原：startedAt=1000，2000 时崩溃（最后活跃），100000 时 resume。
		// 中断 98s 不计入 5s 的 maxWallClockMs。
		const run = makeRun();
		run.budget.startedAt = 1_000;
		run.updatedAt = 2_000;
		const gap = compensateBudgetIdleGap(run, 100_000);
		expect(gap).toBe(98_000);
		expect(run.budget.startedAt).toBe(99_000);
		expect(100_000 - run.budget.startedAt).toBeLessThan(run.budget.maxWallClockMs);
	});

	it("updatedAt 与 now 相同或在未来 → 不顺延", () => {
		const run = makeRun();
		run.budget.startedAt = 1_000;
		run.updatedAt = 5_000;
		expect(compensateBudgetIdleGap(run, 5_000)).toBe(0);
		expect(compensateBudgetIdleGap(run, 4_000)).toBe(0);
		expect(run.budget.startedAt).toBe(1_000);
	});
});

describe("reportingGate 前置门禁（§8.4）", () => {
	it("无 brief → failed_stub", () => {
		const run = makeRun();
		expect(reportingGate(run)).toEqual({ action: "failed_stub", reason: expect.stringContaining("目标理解") });
	});
	it("零证据 → failed_stub", () => {
		const run = makeRun({
			brief: {
				goal: "g",
				scope: { included: [], excluded: [] },
				entities: [],
				successCriteria: [],
				assumptions: [],
				outline: [],
			},
		});
		const gate = reportingGate(run);
		expect(gate.action).toBe("failed_stub");
	});
	it("已熔断 → proceed_degraded", () => {
		const run = makeRun({
			brief: {
				goal: "g",
				scope: { included: [], excluded: [] },
				entities: [],
				successCriteria: [],
				assumptions: [],
				outline: [],
			},
		});
		run.evidence = [
			{
				id: "e1",
				taskId: "T1",
				sourceId: "s1",
				quote: "q",
				summary: "s",
				locator: { start: 0, end: 1 },
				stance: "support",
				quoteMatch: "exact",
				createdAt: 0,
			},
		];
		run.budget.tripped = "cost";
		expect(reportingGate(run)).toEqual({ action: "proceed_degraded" });
	});
	it("正常 → proceed", () => {
		const run = makeRun({
			brief: {
				goal: "g",
				scope: { included: [], excluded: [] },
				entities: [],
				successCriteria: [],
				assumptions: [],
				outline: [],
			},
		});
		run.evidence = [
			{
				id: "e1",
				taskId: "T1",
				sourceId: "s1",
				quote: "q",
				summary: "s",
				locator: { start: 0, end: 1 },
				stance: "support",
				quoteMatch: "exact",
				createdAt: 0,
			},
		];
		expect(reportingGate(run)).toEqual({ action: "proceed" });
	});
});

describe("FailureTracker Query Rewrite 策略池", () => {
	it("按策略池顺序给指引，每次换不同策略", () => {
		const tracker = new FailureTracker();
		const g1 = tracker.onSearchNoResult("T1", "q");
		const g2 = tracker.onSearchNoResult("T1", "q");
		const g3 = tracker.onSearchNoResult("T1", "q");
		expect(g1.hint).toContain(REWRITE_STRATEGIES[0].id);
		expect(g2.hint).toContain(REWRITE_STRATEGIES[1].id);
		expect(g3.hint).toContain(REWRITE_STRATEGIES[2].id);
		expect(g1.exhausted).toBe(false);
	});

	it("超过上限后 exhausted 且禁止再搜", () => {
		const tracker = new FailureTracker();
		for (let i = 0; i < MAX_REWRITE_ATTEMPTS; i++) tracker.onSearchNoResult("T1", "q");
		const g = tracker.onSearchNoResult("T1", "q");
		expect(g.exhausted).toBe(true);
		expect(g.hint).toContain("exhausted");
		expect(g.hint).toContain("Do NOT search");
	});

	it("搜索成功重置 no-result 计数", () => {
		const tracker = new FailureTracker();
		tracker.onSearchNoResult("T1", "q");
		tracker.onSearchNoResult("T1", "q");
		tracker.onSearchSuccess("T1");
		const g = tracker.onSearchNoResult("T1", "q");
		expect(g.hint).toContain(REWRITE_STRATEGIES[0].id);
	});

	it("不同 Task 独立计数", () => {
		const tracker = new FailureTracker();
		for (let i = 0; i < MAX_REWRITE_ATTEMPTS; i++) tracker.onSearchNoResult("T1", "q");
		expect(tracker.onSearchNoResult("T1", "q").exhausted).toBe(true);
		expect(tracker.onSearchNoResult("T2", "q").exhausted).toBe(false);
	});
});

describe("FailureTracker 抓取失败与 quote 拒收", () => {
	it("抓取失败 ≥2 次引导扩量一次，之后收尾", () => {
		const tracker = new FailureTracker();
		tracker.onFetchFailure("T1");
		const g2 = tracker.onFetchFailure("T1");
		expect(g2.hint).toContain("maxResults=10");
		expect(g2.exhausted).toBe(false);
		const g3 = tracker.onFetchFailure("T1");
		expect(g3.exhausted).toBe(true);
	});

	it("quote 拒收 2 次后禁止纠缠该来源", () => {
		const tracker = new FailureTracker();
		tracker.onQuoteRejected("T1", "s1");
		const g = tracker.onQuoteRejected("T1", "s1");
		expect(g.exhausted).toBe(true);
		expect(g.hint).toContain("STOP");
		expect(g.hint).toContain("s1");
	});

	it("quote 接受重置拒收计数", () => {
		const tracker = new FailureTracker();
		tracker.onQuoteRejected("T1", "s1");
		tracker.onQuoteAccepted("T1");
		const g = tracker.onQuoteRejected("T1", "s1");
		expect(g.exhausted).toBe(false);
	});
});

describe("runTaskWithRecovery", () => {
	const recordRecovery = async () => {};

	it("task_exception（failed）→ 重跑 1 次后成功", async () => {
		const task = makeTask("T1", "running", 0);
		let calls = 0;
		const r = await runTaskWithRecovery(task, {
			executeTask: async () => {
				calls++;
				if (calls === 1) {
					task.evidenceCount = 2;
					return { status: "failed", degraded: false, error: "boom" };
				}
				return { status: "success", degraded: false };
			},
			recordRecovery,
		});
		expect(calls).toBe(2);
		expect(r.status).toBe("success");
	});

	it("证据 1..min-1 → 补充子任务 → 达标则 success", async () => {
		const task = makeTask("T1", "running", 0, 3);
		const r = await runTaskWithRecovery(task, {
			executeTask: async (_t, opts) => {
				task.evidenceCount = opts?.queryOverride ? 3 : 2;
				return { status: "success", degraded: task.evidenceCount < 3 };
			},
			recordRecovery,
		});
		expect(r.status).toBe("success");
	});

	it("补充后仍不足 → minEvidence 降为 1，降级 success", async () => {
		const task = makeTask("T1", "running", 0, 3);
		const r = await runTaskWithRecovery(task, {
			executeTask: async () => {
				task.evidenceCount = 1;
				return { status: "success", degraded: true };
			},
			recordRecovery,
		});
		expect(task.minEvidence).toBe(1);
		expect(r.status).toBe("success");
		expect(r.degraded).toBe(true);
	});

	it("证据 0 → unresolved，不重跑", async () => {
		const task = makeTask("T1", "running", 0);
		let calls = 0;
		const r = await runTaskWithRecovery(task, {
			executeTask: async () => {
				calls++;
				task.evidenceCount = 0;
				return { status: "unresolved", degraded: false };
			},
			recordRecovery,
		});
		expect(calls).toBe(1);
		expect(r.status).toBe("unresolved");
	});
});

describe("shouldReplan（L3 Run 级）", () => {
	it("≥30% 失败且未重规划 → true", () => {
		const tasks = [
			makeTask("T1", "failed"),
			makeTask("T2", "unresolved"),
			makeTask("T3", "success", 2),
			makeTask("T4", "success", 2),
		];
		expect(shouldReplan(tasks, 0)).toBe(true);
	});
	it("<30% 失败 → false", () => {
		const tasks = [
			makeTask("T1", "failed"),
			makeTask("T2", "success", 2),
			makeTask("T3", "success", 2),
			makeTask("T4", "success", 2),
		];
		expect(shouldReplan(tasks, 0)).toBe(false);
	});
	it("已重规划过 → false（硬上限 1）", () => {
		const tasks = [makeTask("T1", "failed"), makeTask("T2", "unresolved")];
		expect(shouldReplan(tasks, 1)).toBe(false);
	});
	it("空任务 → false", () => {
		expect(shouldReplan([], 0)).toBe(false);
	});
});
