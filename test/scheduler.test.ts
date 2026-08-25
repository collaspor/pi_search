/**
 * 调度器测试：拓扑分层、循环依赖、并发信号量。
 */

import { describe, expect, it } from "vitest";
import { runWithConcurrency, ScheduleError, topologicalLayers } from "../src/orchestrator/scheduler.ts";
import type { Task } from "../src/types.ts";

function makeTask(id: string, dependsOn: string[] = []): Task {
	return {
		id,
		title: id,
		query: "",
		rationale: "",
		criterionIds: [],
		dependsOn,
		status: "pending",
		attempts: 0,
		evidenceCount: 0,
		minEvidence: 2,
	};
}

describe("topologicalLayers", () => {
	it("无依赖全部在第 0 层", () => {
		const layers = topologicalLayers([makeTask("T1"), makeTask("T2"), makeTask("T3")]);
		expect(layers).toHaveLength(1);
		expect(layers[0].map((t) => t.id)).toEqual(["T1", "T2", "T3"]);
	});

	it("链式依赖逐层递进", () => {
		const layers = topologicalLayers([makeTask("T3", ["T2"]), makeTask("T1"), makeTask("T2", ["T1"])]);
		expect(layers.map((l) => l.map((t) => t.id))).toEqual([["T1"], ["T2"], ["T3"]]);
	});

	it("菱形依赖正确分层", () => {
		const layers = topologicalLayers([
			makeTask("T1"),
			makeTask("T2", ["T1"]),
			makeTask("T3", ["T1"]),
			makeTask("T4", ["T2", "T3"]),
		]);
		expect(layers[0].map((t) => t.id)).toEqual(["T1"]);
		expect(layers[1].map((t) => t.id).sort()).toEqual(["T2", "T3"]);
		expect(layers[2].map((t) => t.id)).toEqual(["T4"]);
	});

	it("循环依赖抛错", () => {
		expect(() => topologicalLayers([makeTask("T1", ["T2"]), makeTask("T2", ["T1"])])).toThrow(ScheduleError);
	});

	it("依赖未知任务抛错", () => {
		expect(() => topologicalLayers([makeTask("T1", ["T99"])])).toThrow(ScheduleError);
	});
});

describe("runWithConcurrency", () => {
	it("concurrency=1 时串行执行", async () => {
		const order: number[] = [];
		let running = 0;
		let maxRunning = 0;
		await runWithConcurrency([1, 2, 3], 1, async (n) => {
			running++;
			maxRunning = Math.max(maxRunning, running);
			await new Promise((r) => setTimeout(r, 10));
			order.push(n);
			running--;
			return n;
		});
		expect(order).toEqual([1, 2, 3]);
		expect(maxRunning).toBe(1);
	});

	it("concurrency=3 时并发执行且结果按索引对齐", async () => {
		let running = 0;
		let maxRunning = 0;
		const results = await runWithConcurrency([1, 2, 3, 4, 5], 3, async (n) => {
			running++;
			maxRunning = Math.max(maxRunning, running);
			await new Promise((r) => setTimeout(r, 20 - n));
			running--;
			return n * 10;
		});
		expect(results).toEqual([10, 20, 30, 40, 50]);
		expect(maxRunning).toBeGreaterThan(1);
		expect(maxRunning).toBeLessThanOrEqual(3);
	});

	it("空数组直接返回", async () => {
		expect(await runWithConcurrency([], 3, async (n) => n)).toEqual([]);
	});
});
