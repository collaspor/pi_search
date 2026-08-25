/**
 * 报告渲染与 L1 校验测试（验收 A5）。
 * markdown 渲染、gaps、L1 六条检查，全部纯函数/本地，无 LLM。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CheckpointStore } from "../src/orchestrator/checkpoint.ts";
import { renderGaps } from "../src/report/gaps.ts";
import {
	extractCitationIds,
	extractFootnoteDefIds,
	removeViolatingCitations,
	renderReport,
	splitBlocks,
	stripFootnoteDefinitions,
} from "../src/report/markdown.ts";
import { l1ErrorMessages, verifyL1 } from "../src/roles/verifier-l1.ts";
import type { Claim, Evidence, ResearchRun, Source, Task } from "../src/types.ts";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "pi-research-report-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function makeSource(id: string, url = "https://example.com/x"): Source {
	return {
		id,
		url,
		canonicalUrl: url,
		title: `${id} 标题`,
		domain: "example.com",
		retrievedAt: new Date("2026-08-25").getTime(),
		tier: 3,
		fetchStrategy: "readability",
		contentHash: "h",
		charCount: 100,
		bodyRef: `sources/${id}.txt`,
	};
}

function makeEvidence(
	id: string,
	taskId: string,
	sourceId: string,
	quote: string,
	quoteMatch: Evidence["quoteMatch"] = "exact",
): Evidence {
	return {
		id,
		taskId,
		sourceId,
		quote,
		summary: `${id} 摘要`,
		locator: { start: 0, end: 1 },
		stance: "support",
		quoteMatch,
		createdAt: 0,
	};
}

function makeClaim(id: string, evidenceIds: string[], criterionIds: string[] = []): Claim {
	return { id, text: `${id} 论断`, evidenceIds, criterionIds, section: "章节" };
}

function makeTask(id: string, criterionIds: string[], status: Task["status"] = "success", evidenceCount = 2): Task {
	return {
		id,
		title: `任务${id}`,
		query: "q",
		rationale: "r",
		criterionIds,
		dependsOn: [],
		status,
		attempts: 1,
		evidenceCount,
		minEvidence: 2,
	};
}

function makeRun(overrides?: Partial<ResearchRun>): ResearchRun {
	return {
		id: "run-1",
		query: "测试问题",
		status: "verifying",
		createdAt: 0,
		updatedAt: 0,
		schemaVersion: 1,
		brief: {
			goal: "目标",
			scope: { included: [], excluded: [] },
			entities: [],
			successCriteria: [
				{ id: "SC1", text: "判据一" },
				{ id: "SC2", text: "判据二" },
			],
			assumptions: [],
			outline: ["章节一", "章节二"],
		},
		plan: { tasks: [makeTask("T1", ["SC1"]), makeTask("T2", ["SC2"])], replanCount: 0 },
		sources: [makeSource("s1"), makeSource("s2")],
		evidence: [makeEvidence("e1", "T1", "s1", "原文一"), makeEvidence("e2", "T2", "s2", "原文二")],
		claims: [makeClaim("c1", ["e1"]), makeClaim("c2", ["e2"])],
		budget: {
			maxTokens: 1e6,
			maxCostUsd: 10,
			maxWallClockMs: 1e6,
			maxTasks: 8,
			maxFetchPerTask: 5,
			usedTokens: 0,
			usedCostUsd: 0,
			startedAt: 0,
		},
		recoveries: [],
		lastSeq: 0,
		...overrides,
	};
}

describe("markdown 渲染", () => {
	it("脚注定义行由代码生成，含来源与日期", () => {
		const sources = new Map([["e1", makeSource("s1")]]);
		const r = renderReport("市场规模达 1280 亿[^e1]。", new Set(["e1"]), sources);
		expect(r.markdown).toContain("[^e1]: [s1 标题](https://example.com/x)");
		expect(r.markdown).toContain("检索于 2026-08-25");
		expect(r.danglingIds).toEqual([]);
	});

	it("LLM 自写的定义行被剥离重建", () => {
		const sources = new Map([["e1", makeSource("s1")]]);
		const llmMarkdown = "结论[^e1]。\n\n[^e1]: [伪造来源](https://evil.com) — 假日期";
		const r = renderReport(llmMarkdown, new Set(["e1"]), sources);
		expect(r.markdown).not.toContain("evil.com");
		expect(r.markdown).toContain("[^e1]: [s1 标题]");
	});

	it("悬空引用被检出", () => {
		const r = renderReport("错误引用[^e99]。", new Set(["e1"]), new Map());
		expect(r.danglingIds).toEqual(["e99"]);
	});

	it("转义的 \\[^e1] 不计为引用", () => {
		expect(extractCitationIds("这是转义 \\[^e1] 不是引用")).toEqual([]);
	});

	it("脚注定义行的标签不计为正文引用", () => {
		const md = "正文[^e1]。\n\n[^e1]: [t](u)";
		expect(extractCitationIds(md)).toEqual(["e1"]);
		expect(extractFootnoteDefIds(md)).toEqual(["e1"]);
	});

	it("Source.title 中的恶意 markdown 被转义", () => {
		const source = makeSource("s1");
		source.title = "标题 [^e99] 伪造脚注";
		const r = renderReport("引用[^e1]。", new Set(["e1"]), new Map([["e1", source]]));
		expect(r.markdown).toContain("\\[^e99\\]");
	});
});

describe("按块剔除", () => {
	it("整块只含违规引用 → 删整块", () => {
		const md = "合法结论[^e1]。\n\n完全基于违规证据的段落[^e99]。\n\n另一合法段[^e2]。";
		const out = removeViolatingCitations(md, new Set(["e99"]));
		expect(out).toContain("[^e1]");
		expect(out).toContain("[^e2]");
		expect(out).not.toContain("e99");
		expect(out).not.toContain("违规证据的段落");
	});

	it("混合块句级剔除只删违规句", () => {
		const md = "第一句有合法引用[^e1]。第二句有违规引用[^e99]。";
		const out = removeViolatingCitations(md, new Set(["e99"]));
		expect(out).toContain("第一句有合法引用[^e1]");
		expect(out).not.toContain("第二句");
	});

	it("标题块永不删除", () => {
		const md = "# 章节标题\n\n含违规引用的段落[^e99]。";
		const out = removeViolatingCitations(md, new Set(["e99"]));
		expect(out).toContain("# 章节标题");
	});

	it("splitBlocks 按空行切块", () => {
		expect(splitBlocks("a\n\nb\n\n\nc")).toEqual(["a", "b", "c"]);
	});

	it("stripFootnoteDefinitions 删除定义行", () => {
		const md = "正文[^e1]。\n\n[^e1]: [t](u)\n[^e2]: [t2](u2)";
		expect(stripFootnoteDefinitions(md)).toBe("正文[^e1]。");
	});
});

describe("研究空白章节", () => {
	it("unresolved/failed 任务列入", () => {
		const run = makeRun();
		run.plan!.tasks = [
			makeTask("T1", ["SC1"], "success"),
			{ ...makeTask("T2", ["SC2"], "unresolved", 0), attempts: 3 },
		];
		const gaps = renderGaps(run);
		expect(gaps).toContain("研究空白");
		expect(gaps).toContain("任务T2");
		expect(gaps).not.toContain("任务T1");
	});

	it("gaveUp 的 recovery 派生人性化原因", () => {
		const run = makeRun();
		run.plan!.tasks = [{ ...makeTask("T1", ["SC1"], "unresolved", 0), attempts: 3 }];
		run.recoveries = [
			{
				ts: 0,
				level: "task",
				taskId: "T1",
				failureType: "no_search_result",
				strategy: "query_rewrite",
				attempt: 3,
				outcome: "gaveUp",
				detail: "",
			},
		];
		const gaps = renderGaps(run);
		expect(gaps).toContain("多次搜索无有效结果");
		expect(gaps).toContain("尝试 3 次");
	});

	it("全部成功时无空白章节", () => {
		expect(renderGaps(makeRun())).toBe("");
	});

	it("预算中断的 pending 任务单列一节", () => {
		const run = makeRun();
		run.plan!.tasks = [makeTask("T1", ["SC1"], "success"), makeTask("T2", ["SC2"], "pending", 0)];
		const gaps = renderGaps(run);
		expect(gaps).toContain("未执行");
		expect(gaps).toContain("任务T2");
	});
});

describe("L1 校验（A5）", () => {
	async function setupStore(run: ResearchRun): Promise<CheckpointStore> {
		const store = await CheckpointStore.create(dir, run.id);
		for (const e of run.evidence) {
			await store.writeSourceBody(e.sourceId, e.quote);
		}
		return store;
	}

	it("全部合法 → passed，零悬空引用", async () => {
		const run = makeRun();
		const store = await setupStore(run);
		const { markdown } = renderReport(
			"结论一[^e1]。结论二[^e2]。",
			new Set(["e1", "e2"]),
			new Map([
				["e1", run.sources[0]],
				["e2", run.sources[1]],
			]),
		);
		const l1 = await verifyL1({ run, store, renderedMarkdown: markdown });

		expect(l1.danglingCitations).toEqual([]);
		expect(l1.unsupportedClaims).toEqual([]);
		expect(l1.untraceableEvidence).toEqual([]);
		expect(l1.uncoveredCriteria).toEqual([]);
		expect(l1.passed).toBe(true);
	});

	it("悬空引用 → 阻断", async () => {
		const run = makeRun();
		const store = await setupStore(run);
		const l1 = await verifyL1({ run, store, renderedMarkdown: "错误引用[^e99]。" });
		expect(l1.danglingCitations).toEqual(["e99"]);
		expect(l1.passed).toBe(false);
		expect(l1ErrorMessages(l1).some((m) => m.includes("e99"))).toBe(true);
	});

	it("Claim 引用不存在的 evidence → 阻断", async () => {
		const run = makeRun({ claims: [makeClaim("c1", ["e999"])] });
		const store = await setupStore(run);
		const l1 = await verifyL1({ run, store, renderedMarkdown: "无引用正文。" });
		expect(l1.unsupportedClaims).toEqual(["c1"]);
		expect(l1.passed).toBe(false);
	});

	it("quote 无法在正文定位 → 阻断", async () => {
		const run = makeRun({ evidence: [makeEvidence("e1", "T1", "s1", "这句话不在正文里")] });
		run.claims = [makeClaim("c1", ["e1"])];
		const store = await CheckpointStore.create(dir, run.id);
		await store.writeSourceBody("s1", "完全不同的正文内容");
		const l1 = await verifyL1({ run, store, renderedMarkdown: "引用[^e1]。" });
		expect(l1.untraceableEvidence).toEqual(["e1"]);
		expect(l1.passed).toBe(false);
	});

	it("Reporter 打满 SC 标签不能让覆盖度通过（血缘）", async () => {
		// T2 绑定 SC2 但无 evidence；claim 自报 criterionIds 含 SC2
		const run = makeRun();
		run.evidence = [makeEvidence("e1", "T1", "s1", "原文一")];
		run.claims = [{ ...makeClaim("c1", ["e1"]), criterionIds: ["SC1", "SC2"] }];
		const store = await setupStore(run);
		const l1 = await verifyL1({ run, store, renderedMarkdown: "引用[^e1]。" });
		expect(l1.uncoveredCriteria).toEqual(["SC2"]);
		expect(l1.passed).toBe(false);
	});

	it("fuzzy 独撑的 Claim 告警", async () => {
		const run = makeRun({ evidence: [makeEvidence("e1", "T1", "s1", "原文一", "fuzzy")] });
		run.claims = [makeClaim("c1", ["e1"])];
		const store = await setupStore(run);
		const l1 = await verifyL1({ run, store, renderedMarkdown: "引用[^e1]。" });
		expect(l1.fuzzySoleSupport).toEqual(["c1"]);
	});

	it("未使用证据告警", async () => {
		const run = makeRun({
			evidence: [makeEvidence("e1", "T1", "s1", "原文一"), makeEvidence("e3", "T1", "s1", "原文三")],
		});
		run.claims = [makeClaim("c1", ["e1"])];
		const store = await setupStore(run);
		const l1 = await verifyL1({ run, store, renderedMarkdown: "引用[^e1]。" });
		expect(l1.unusedEvidence).toEqual(["e3"]);
	});
});
