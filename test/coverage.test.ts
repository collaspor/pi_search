/**
 * 覆盖度血缘反推测试（评审 P0-3 / 验收 A5）。
 * 核心断言：Reporter 给 claim 打满全部 SC 标签，不能让覆盖度通过。
 */

import { describe, expect, it } from "vitest";
import type { Claim, Criterion, Evidence, Task } from "../src/types.ts";
import { computeCoverage } from "../src/verify/coverage.ts";

const criteria: Criterion[] = [
	{ id: "SC1", text: "市场规模量化数据" },
	{ id: "SC2", text: "增长率与驱动因素" },
	{ id: "SC3", text: "三家产品线横向对比" },
];

function makeTask(id: string, criterionIds: string[]): Task {
	return {
		id,
		title: id,
		query: "",
		rationale: "",
		criterionIds,
		dependsOn: [],
		status: "success",
		attempts: 1,
		evidenceCount: 0,
		minEvidence: 2,
	};
}

function makeEvidence(id: string, taskId: string): Evidence {
	return {
		id,
		taskId,
		sourceId: "s1",
		quote: "q",
		summary: "s",
		locator: { start: 0, end: 1 },
		stance: "support",
		quoteMatch: "exact",
		createdAt: 0,
	};
}

function makeClaim(id: string, evidenceIds: string[], criterionIds: string[]): Claim {
	return { id, text: "claim", evidenceIds, criterionIds, section: "sec" };
}

describe("computeCoverage — 血缘链完整时判覆盖", () => {
	it("全部 SC 被覆盖", () => {
		const tasks = [makeTask("T1", ["SC1"]), makeTask("T2", ["SC2"]), makeTask("T3", ["SC3"])];
		const evidence = [makeEvidence("e1", "T1"), makeEvidence("e2", "T2"), makeEvidence("e3", "T3")];
		const claims = [makeClaim("c1", ["e1", "e2", "e3"], [])];

		const r = computeCoverage(criteria, tasks, evidence, claims);
		expect(r.passed).toBe(true);
		expect(r.uncoveredCriteria).toEqual([]);
		expect(r.coverage.every((c) => c.claimCount > 0)).toBe(true);
	});

	it("某 SC 无 Task 绑定时未覆盖", () => {
		const tasks = [makeTask("T1", ["SC1"]), makeTask("T2", ["SC2"])]; // SC3 无 task
		const evidence = [makeEvidence("e1", "T1"), makeEvidence("e2", "T2")];
		const claims = [makeClaim("c1", ["e1", "e2"], [])];

		const r = computeCoverage(criteria, tasks, evidence, claims);
		expect(r.passed).toBe(false);
		expect(r.uncoveredCriteria).toEqual(["SC3"]);
	});

	it("Task 产出了 evidence 但未被任何 claim 引用时未覆盖", () => {
		const tasks = [makeTask("T1", ["SC1"]), makeTask("T2", ["SC2"]), makeTask("T3", ["SC3"])];
		const evidence = [makeEvidence("e1", "T1"), makeEvidence("e2", "T2"), makeEvidence("e3", "T3")];
		// claim 只引用 e1 e2，T3 的 e3 被收集但未被引用
		const claims = [makeClaim("c1", ["e1", "e2"], [])];

		const r = computeCoverage(criteria, tasks, evidence, claims);
		expect(r.passed).toBe(false);
		expect(r.uncoveredCriteria).toEqual(["SC3"]);
	});
});

describe("computeCoverage — 抵御自报标签绕过（P0-3 场景）", () => {
	it("Reporter 给 claim 打满全部 SC 标签，不能让未覆盖的 SC 通过", () => {
		const tasks = [makeTask("T1", ["SC1"]), makeTask("T2", ["SC2"]), makeTask("T3", ["SC3"])];
		// T3 绑定 SC3，但没有产出任何 evidence
		const evidence = [makeEvidence("e1", "T1"), makeEvidence("e2", "T2")];
		// Reporter 偷懒：给 c1 填上全部 SC 标签，试图蒙混
		const claims = [makeClaim("c1", ["e1", "e2"], ["SC1", "SC2", "SC3"])];

		const r = computeCoverage(criteria, tasks, evidence, claims);
		// 血缘：SC3 → T3 → T3 无 evidence → 链断 → 未覆盖
		expect(r.passed).toBe(false);
		expect(r.uncoveredCriteria).toEqual(["SC3"]);
	});

	it("claim 引用了不存在的 evidence id，不构成血缘（由 L1 另行判 dangling）", () => {
		const tasks = [makeTask("T1", ["SC1"])];
		const evidence: Evidence[] = [];
		const claims = [makeClaim("c1", ["e999"], [])]; // 悬空引用

		const r = computeCoverage(criteria.slice(0, 1), tasks, evidence, claims);
		expect(r.passed).toBe(false);
	});
});

describe("computeCoverage — 边界", () => {
	it("空 criteria 直接通过", () => {
		const r = computeCoverage([], [], [], []);
		expect(r.passed).toBe(true);
		expect(r.coverage).toEqual([]);
	});
	it("一个 claim 引用同一 task 多条 evidence，claimCount 按 task 计一次", () => {
		const tasks = [makeTask("T1", ["SC1"])];
		const evidence = [makeEvidence("e1", "T1"), makeEvidence("e2", "T1")];
		const claims = [makeClaim("c1", ["e1", "e2"], [])];

		const r = computeCoverage(criteria.slice(0, 1), tasks, evidence, claims);
		expect(r.coverage[0].claimCount).toBe(1); // 同一 task 去重
	});
});
