/**
 * M7 测试：L2 语义校验、isAllSupported 判定、Trace 渲染、resume replay。
 * L2 用 faux provider，Trace/replay 纯逻辑，全部离线。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderRunListItem, renderTrace } from "../src/observability/trace.ts";
import { CheckpointStore, readEvents } from "../src/orchestrator/checkpoint.ts";
import { replayEvents } from "../src/orchestrator/replay.ts";
import { isAllSupported, verifyL2 } from "../src/roles/verifier-l2.ts";
import type { Claim, Evidence, ResearchEvent, ResearchRun, Source } from "../src/types.ts";

let dir: string;
const registrations: { unregister: () => void }[] = [];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "pi-research-m7-"));
});

afterEach(async () => {
	while (registrations.length > 0) registrations.pop()?.unregister();
	await rm(dir, { recursive: true, force: true });
});

function setupFaux() {
	const r = registerFauxProvider({});
	registrations.push(r);
	return r;
}

function makeSource(id: string): Source {
	return {
		id,
		url: `https://example.com/${id}`,
		canonicalUrl: `https://example.com/${id}`,
		title: `${id}标题`,
		domain: "example.com",
		retrievedAt: 0,
		tier: 3,
		fetchStrategy: "readability",
		contentHash: "h",
		charCount: 100,
		bodyRef: `sources/${id}.txt`,
	};
}

function makeEvidence(id: string, taskId: string, sourceId: string, stance: Evidence["stance"] = "support"): Evidence {
	return {
		id,
		taskId,
		sourceId,
		quote: `${id} 原文`,
		summary: `${id} 摘要`,
		locator: { start: 0, end: 1 },
		stance,
		quoteMatch: "exact",
		createdAt: 0,
	};
}

function makeClaim(id: string, evidenceIds: string[]): Claim {
	return { id, text: `${id} 论断`, evidenceIds, criterionIds: [], section: "章节" };
}

function makeRun(overrides?: Partial<ResearchRun>): ResearchRun {
	return {
		id: "run-1",
		query: "测试问题",
		status: "completed",
		createdAt: 1000,
		updatedAt: 5000,
		schemaVersion: 1,
		brief: {
			goal: "目标",
			scope: { included: [], excluded: [] },
			entities: [],
			successCriteria: [{ id: "SC1", text: "判据" }],
			assumptions: [],
			outline: ["章节"],
		},
		plan: { tasks: [], replanCount: 0 },
		sources: [makeSource("s1")],
		evidence: [makeEvidence("e1", "T1", "s1")],
		claims: [makeClaim("c1", ["e1"])],
		budget: {
			maxTokens: 1e6,
			maxCostUsd: 10,
			maxWallClockMs: 1e6,
			maxTasks: 8,
			maxFetchPerTask: 5,
			usedTokens: 0,
			usedCostUsd: 0,
			startedAt: 1000,
		},
		recoveries: [],
		lastSeq: 0,
		...overrides,
	};
}

describe("verifyL2（L2 语义校验）", () => {
	it("逐 claim 判定 verdict 并强制 citedEvidenceIds", async () => {
		const faux = setupFaux();
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("submit_verdict", { verdict: "supported", reason: "证据直接支撑", citedEvidenceIds: ["e1"] }),
			),
		]);
		const verdicts = await verifyL2({
			model: faux.getModel(),
			claims: [makeClaim("c1", ["e1"])],
			evidence: [makeEvidence("e1", "T1", "s1")],
			sources: [makeSource("s1")],
		});
		expect(verdicts).toHaveLength(1);
		expect(verdicts[0].verdict).toBe("supported");
		expect(verdicts[0].citedEvidenceIds).toEqual(["e1"]);
	});

	it("claim 无任何证据 → 直接 unsupported，不调 LLM", async () => {
		const faux = setupFaux();
		faux.setResponses([]);
		const verdicts = await verifyL2({
			model: faux.getModel(),
			claims: [makeClaim("c1", ["e999"])],
			evidence: [],
			sources: [],
		});
		expect(verdicts[0].verdict).toBe("unsupported");
		expect(faux.state.callCount).toBe(0);
	});

	it("检索包含同 task 的其他证据与 refute 证据（对抗检索共谋）", async () => {
		const faux = setupFaux();
		let seenEvidenceIds: string[] = [];
		faux.setResponses([
			(context) => {
				const user = context.messages.find((m) => m.role === "user");
				const text = typeof user?.content === "string" ? user.content : "";
				seenEvidenceIds = [...text.matchAll(/\[(e\d+)\]/g)].map((m) => m[1]);
				return fauxAssistantMessage(
					fauxToolCall("submit_verdict", { verdict: "conflicting", reason: "x", citedEvidenceIds: ["e1"] }),
				);
			},
		]);
		await verifyL2({
			model: faux.getModel(),
			claims: [makeClaim("c1", ["e1"])],
			evidence: [
				makeEvidence("e1", "T1", "s1"),
				makeEvidence("e2", "T1", "s1"),
				makeEvidence("e3", "T2", "s1", "refute"),
			],
			sources: [makeSource("s1")],
		});
		expect(seenEvidenceIds).toContain("e1");
		expect(seenEvidenceIds).toContain("e2"); // 同 task
		expect(seenEvidenceIds).toContain("e3"); // refute
	});

	it("LLM 调用失败 → uncertain，不中断整体", async () => {
		const faux = setupFaux();
		faux.setResponses([fauxAssistantMessage("我不调用工具")]);
		const verdicts = await verifyL2({
			model: faux.getModel(),
			claims: [makeClaim("c1", ["e1"])],
			evidence: [makeEvidence("e1", "T1", "s1")],
			sources: [makeSource("s1")],
		});
		expect(verdicts[0].verdict).toBe("uncertain");
	});
});

describe("isAllSupported（橡皮图章信号）", () => {
	it("全 supported → true", () => {
		expect(
			isAllSupported([
				{ claimId: "c1", verdict: "supported", reason: "", citedEvidenceIds: ["e1"] },
				{ claimId: "c2", verdict: "supported", reason: "", citedEvidenceIds: ["e1"] },
			]),
		).toBe(true);
	});
	it("有非 supported → false", () => {
		expect(
			isAllSupported([
				{ claimId: "c1", verdict: "supported", reason: "", citedEvidenceIds: ["e1"] },
				{ claimId: "c2", verdict: "conflicting", reason: "", citedEvidenceIds: ["e1"] },
			]),
		).toBe(false);
	});
	it("空数组 → false", () => {
		expect(isAllSupported([])).toBe(false);
	});
});

describe("renderTrace（Trace 树）", () => {
	it("渲染阶段与任务树", () => {
		const run = makeRun();
		run.plan = {
			replanCount: 0,
			tasks: [
				{
					id: "T1",
					title: "市场规模",
					query: "q",
					rationale: "r",
					criterionIds: ["SC1"],
					dependsOn: [],
					status: "success",
					attempts: 1,
					evidenceCount: 3,
					minEvidence: 2,
				},
				{
					id: "T2",
					title: "竞争格局",
					query: "q",
					rationale: "r",
					criterionIds: ["SC1"],
					dependsOn: [],
					status: "unresolved",
					attempts: 2,
					evidenceCount: 0,
					minEvidence: 2,
				},
			],
		};
		const events: ResearchEvent[] = [
			{ seq: 1, ts: 1000, runId: "run-1", type: "phase_enter", phase: "comprehending" },
			{ seq: 2, ts: 1001, runId: "run-1", type: "phase_enter", phase: "planning" },
			{ seq: 3, ts: 1002, runId: "run-1", type: "phase_enter", phase: "researching" },
			{ seq: 4, ts: 1003, runId: "run-1", type: "task_start", taskId: "T1" },
			{
				seq: 5,
				ts: 1004,
				runId: "run-1",
				type: "tool_call",
				taskId: "T1",
				tool: "web_search",
				argsHash: "h1",
				latencyMs: 1200,
				ok: true,
			},
			{ seq: 6, ts: 2004, runId: "run-1", type: "task_end", taskId: "T1", status: "success", evidenceCount: 3 },
			{ seq: 7, ts: 2005, runId: "run-1", type: "task_start", taskId: "T2" },
			{
				seq: 8,
				ts: 2006,
				runId: "run-1",
				type: "recovery",
				event: {
					ts: 2006,
					level: "task",
					taskId: "T2",
					failureType: "no_search_result",
					strategy: "query_rewrite:simplify",
					attempt: 1,
					outcome: "degraded",
					detail: "",
				},
			},
			{ seq: 9, ts: 3006, runId: "run-1", type: "task_end", taskId: "T2", status: "unresolved", evidenceCount: 0 },
			{ seq: 10, ts: 3007, runId: "run-1", type: "phase_enter", phase: "reporting" },
			{ seq: 11, ts: 3008, runId: "run-1", type: "phase_enter", phase: "verifying" },
		];
		const trace = renderTrace(run, events);
		expect(trace).toContain("Research Run run-1");
		expect(trace).toContain("[1] Comprehend");
		expect(trace).toContain("[2] Plan");
		expect(trace).toContain("[3] Research");
		expect(trace).toContain("T1 市场规模");
		expect(trace).toContain("T2 竞争格局");
		expect(trace).toContain("✓");
		expect(trace).toContain("⚠");
		expect(trace).toContain("no_result");
		expect(trace).toContain("Report:");
	});

	it("renderRunListItem 单行摘要", () => {
		const item = renderRunListItem(makeRun());
		expect(item).toContain("run-1");
		expect(item).toContain("completed");
		expect(item).toContain("测试问题");
	});
});

describe("resume replay（断点续跑）", () => {
	it("快照 + 事件流恢复现场，从第一个 pending 任务续跑", async () => {
		const run = makeRun({ status: "researching" });
		run.plan = {
			replanCount: 0,
			tasks: [
				{
					id: "T1",
					title: "t1",
					query: "q",
					rationale: "r",
					criterionIds: [],
					dependsOn: [],
					status: "success",
					attempts: 1,
					evidenceCount: 2,
					minEvidence: 2,
				},
				{
					id: "T2",
					title: "t2",
					query: "q",
					rationale: "r",
					criterionIds: [],
					dependsOn: [],
					status: "pending",
					attempts: 0,
					evidenceCount: 0,
					minEvidence: 2,
				},
			],
		};
		const store = await CheckpointStore.create(dir, run.id);
		run.lastSeq = 2;
		await store.writeSnapshot(run);
		// 崩溃后又有 1 条事件（快照之后）
		await store.appendEvent({ type: "task_end", taskId: "T1", status: "success", evidenceCount: 2 });

		const events = await readEvents(store.eventsPath);
		const result = replayEvents(run, events);
		// 核心断言：resume 起点是第一个 pending 任务
		expect(result.resumeFromTaskId).toBe("T2");
		// 原快照不被修改（replay 深拷贝）
		expect(run.plan?.tasks[1].status).toBe("pending");
		// T2 的重放在 result.run 中状态被事件更新
		expect(result.run.plan?.tasks[0].status).toBe("success");
	});

	it("已全部完成的任务无 resume 起点", async () => {
		const run = makeRun();
		run.plan = {
			replanCount: 0,
			tasks: [
				{
					id: "T1",
					title: "t1",
					query: "q",
					rationale: "r",
					criterionIds: [],
					dependsOn: [],
					status: "success",
					attempts: 1,
					evidenceCount: 2,
					minEvidence: 2,
				},
			],
		};
		const result = replayEvents(run, []);
		expect(result.resumeFromTaskId).toBeUndefined();
	});
});
