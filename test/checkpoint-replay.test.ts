/**
 * checkpoint + replay 测试（PRD §4.0.1 / 验收 A9）。
 * 覆盖：原子写、事件顺序、lastSeq 丢弃、argsHash 幂等、resume 起点。
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CheckpointStore, hashArgs, readEvents, stableStringify } from "../src/orchestrator/checkpoint.ts";
import { replayEvents } from "../src/orchestrator/replay.ts";
import type { ResearchEvent, ResearchRun } from "../src/types.ts";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "pi-research-test-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function makeRun(lastSeq: number): ResearchRun {
	return {
		id: "run-1",
		query: "test query",
		status: "researching",
		createdAt: 1000,
		updatedAt: 1000,
		schemaVersion: 1,
		sources: [],
		evidence: [],
		claims: [],
		budget: {
			maxTokens: 400000,
			maxCostUsd: 2,
			maxWallClockMs: 900000,
			maxTasks: 8,
			maxFetchPerTask: 5,
			usedTokens: 0,
			usedCostUsd: 0,
			startedAt: 1000,
		},
		recoveries: [],
		lastSeq,
	};
}

function ev(seq: number, payload: Record<string, unknown>): ResearchEvent {
	return { seq, ts: 1000 + seq, runId: "run-1", ...payload } as unknown as ResearchEvent;
}

describe("CheckpointStore", () => {
	it("快照原子写：不留 tmp 残文件，内容完整", async () => {
		const store = await CheckpointStore.create(dir, "run-1");
		const run = makeRun(0);
		await store.writeSnapshot(run);

		const text = await readFile(join(dir, "run.json"), "utf8");
		expect(JSON.parse(text).id).toBe("run-1");
		// rename 后 tmp 文件不存在
		await expect(readFile(join(dir, "run.json.tmp"), "utf8")).rejects.toThrow();
	});

	it("事件追加且 seq 单调递增", async () => {
		const store = await CheckpointStore.create(dir, "run-1");
		const e1 = await store.appendEvent({ type: "phase_enter", phase: "comprehending" });
		const e2 = await store.appendEvent({ type: "task_start", taskId: "T1" });
		expect(e1.seq).toBe(1);
		expect(e2.seq).toBe(2);

		const events = await readEvents(join(dir, "events.jsonl"));
		expect(events).toHaveLength(2);
		expect(events[0].seq).toBe(1);
		expect(events[1].seq).toBe(2);
	});

	it("open 从 lastSeq 继续编号", async () => {
		const run = makeRun(7);
		const store = await CheckpointStore.open(dir, run);
		const e = await store.appendEvent({ type: "task_start", taskId: "T1" });
		expect(e.seq).toBe(8);
	});

	it("source 正文落盘与读取", async () => {
		const store = await CheckpointStore.create(dir, "run-1");
		await store.writeSourceBody("s1", "正文内容");
		const body = await store.readSourceBody("s1");
		expect(body).toBe("正文内容");
		expect(await store.readSourceBody("s999")).toBeUndefined();
	});
});

describe("readEvents", () => {
	it("文件不存在返回空数组", async () => {
		expect(await readEvents(join(dir, "nonexistent.jsonl"))).toEqual([]);
	});
	it("容忍末尾空行", async () => {
		const path = join(dir, "events.jsonl");
		await writeFile(path, `${JSON.stringify(ev(1, { type: "task_start", taskId: "T1" }))}\n\n`, "utf8");
		const events = await readEvents(path);
		expect(events).toHaveLength(1);
	});
});

describe("replayEvents — lastSeq 丢弃（验收 A9）", () => {
	it("seq <= lastSeq 的事件被丢弃，只应用更新的", () => {
		const snapshot = makeRun(2);
		snapshot.plan = {
			replanCount: 0,
			tasks: [
				{
					id: "T1",
					title: "",
					query: "",
					rationale: "",
					criterionIds: [],
					dependsOn: [],
					status: "pending",
					attempts: 0,
					evidenceCount: 0,
					minEvidence: 2,
				},
			],
		};
		const events = [
			ev(1, { type: "task_start", taskId: "T1" }), // seq 1 <= 2，丢弃
			ev(2, { type: "task_start", taskId: "T1" }), // seq 2 <= 2，丢弃
			ev(3, { type: "task_end", taskId: "T1", status: "success", evidenceCount: 3 }), // 应用
		];

		const r = replayEvents(snapshot, events);
		expect(r.applied).toBe(1);
		expect(r.skipped).toBe(2);
		expect(r.run.plan?.tasks[0].status).toBe("success");
		expect(r.run.plan?.tasks[0].evidenceCount).toBe(3);
		// 快照原对象不被修改
		expect(snapshot.plan?.tasks[0].status).toBe("pending");
	});

	it("重放后 lastSeq 推进到最新事件", () => {
		const snapshot = makeRun(1);
		const events = [
			ev(2, { type: "phase_enter", phase: "reporting" }),
			ev(5, { type: "run_end", status: "completed" }),
		];
		const r = replayEvents(snapshot, events);
		expect(r.run.lastSeq).toBe(5);
		expect(r.run.status).toBe("completed");
	});
});

describe("replayEvents — argsHash 幂等", () => {
	it("成功的 tool_call 收集为幂等键", () => {
		const snapshot = makeRun(0);
		const events = [
			ev(1, { type: "tool_call", taskId: "T1", tool: "web_search", argsHash: "abc123", latencyMs: 100, ok: true }),
			ev(2, {
				type: "tool_call",
				taskId: "T1",
				tool: "web_fetch",
				argsHash: "def456",
				latencyMs: 200,
				ok: false,
				failureType: "timeout",
			}),
		];
		const r = replayEvents(snapshot, events);
		expect(r.succeededToolCalls.has("abc123")).toBe(true);
		expect(r.succeededToolCalls.has("def456")).toBe(false); // 失败的不算
	});
});

describe("replayEvents — resume 起点", () => {
	it("返回首个 pending task 作为 resume 起点", () => {
		const snapshot = makeRun(0);
		snapshot.plan = {
			replanCount: 0,
			tasks: [
				{
					id: "T1",
					title: "",
					query: "",
					rationale: "",
					criterionIds: [],
					dependsOn: [],
					status: "success",
					attempts: 1,
					evidenceCount: 2,
					minEvidence: 2,
				},
				{
					id: "T2",
					title: "",
					query: "",
					rationale: "",
					criterionIds: [],
					dependsOn: [],
					status: "pending",
					attempts: 0,
					evidenceCount: 0,
					minEvidence: 2,
				},
				{
					id: "T3",
					title: "",
					query: "",
					rationale: "",
					criterionIds: [],
					dependsOn: [],
					status: "pending",
					attempts: 0,
					evidenceCount: 0,
					minEvidence: 2,
				},
			],
		};
		const r = replayEvents(snapshot, []);
		expect(r.resumeFromTaskId).toBe("T2");
	});
	it("全部完成时无 resume 起点", () => {
		const snapshot = makeRun(0);
		snapshot.plan = {
			replanCount: 0,
			tasks: [
				{
					id: "T1",
					title: "",
					query: "",
					rationale: "",
					criterionIds: [],
					dependsOn: [],
					status: "success",
					attempts: 1,
					evidenceCount: 2,
					minEvidence: 2,
				},
			],
		};
		const r = replayEvents(snapshot, []);
		expect(r.resumeFromTaskId).toBeUndefined();
	});
});

describe("replayEvents — 乱序防御", () => {
	it("事件乱序时按 seq 排序后应用", () => {
		const snapshot = makeRun(0);
		snapshot.plan = {
			replanCount: 0,
			tasks: [
				{
					id: "T1",
					title: "",
					query: "",
					rationale: "",
					criterionIds: [],
					dependsOn: [],
					status: "pending",
					attempts: 0,
					evidenceCount: 0,
					minEvidence: 2,
				},
			],
		};
		// 故意乱序：end 在 start 之前
		const events = [
			ev(2, { type: "task_end", taskId: "T1", status: "success", evidenceCount: 2 }),
			ev(1, { type: "task_start", taskId: "T1" }),
		];
		const r = replayEvents(snapshot, events);
		expect(r.run.plan?.tasks[0].status).toBe("success");
	});
});

describe("stableStringify / hashArgs", () => {
	it("键序不影响哈希", () => {
		expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
		expect(hashArgs({ query: "AI", maxResults: 5 })).toBe(hashArgs({ maxResults: 5, query: "AI" }));
	});
	it("嵌套对象与数组稳定", () => {
		expect(stableStringify({ a: [1, { b: 2, c: 3 }] })).toBe(stableStringify({ a: [1, { c: 3, b: 2 }] }));
	});
	it("不同参数不同哈希", () => {
		expect(hashArgs({ query: "AI" })).not.toBe(hashArgs({ query: "BI" }));
	});
});
