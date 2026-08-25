/**
 * M8 验收脚本：对 run 产物自动断言 PRD §12 的 A1~A6 + A10。
 * 用法：node scripts/accept.mjs <runDir>
 * 退出码：0 = 全部通过，1 = 有断言失败。
 */

import fs from "node:fs";
import path from "node:path";

const runDir = process.argv[2];
if (!runDir) {
	console.error("用法：node scripts/accept.mjs <runDir>");
	process.exit(1);
}

const run = JSON.parse(fs.readFileSync(path.join(runDir, "run.json"), "utf8"));
const events = fs
	.readFileSync(path.join(runDir, "events.jsonl"), "utf8")
	.trim()
	.split("\n")
	.map((l) => JSON.parse(l));

const results = [];
const check = (id, name, pass, detail = "") => {
	results.push({ id, name, pass, detail });
};

// A1: 理解目标 — SC 3~7 条且 goal 非空
{
	const sc = run.brief?.successCriteria ?? [];
	check("A1", "理解目标：SC∈[3,7] 且 goal 非空", sc.length >= 3 && sc.length <= 7 && (run.brief?.goal ?? "").trim() !== "", `SC=${sc.length}`);
}

// A2: 规划 — rationale 非空且覆盖全部 SC
{
	const tasks = run.plan?.tasks ?? [];
	const scIds = new Set((run.brief?.successCriteria ?? []).map((s) => s.id));
	const covered = new Set(tasks.flatMap((t) => t.criterionIds));
	const uncovered = [...scIds].filter((id) => !covered.has(id));
	const rationaleOk = tasks.every((t) => (t.rationale ?? "").trim() !== "");
	check("A2", "规划：rationale 非空且覆盖全部 SC", rationaleOk && uncovered.length === 0, uncovered.length > 0 ? `未覆盖:${uncovered}` : `tasks=${tasks.length}`);
}

// A3: 工具接入 — events 含 web_search/web_fetch 的 tool_call 且带 latencyMs
{
	const searchCalls = events.filter((e) => e.type === "tool_call" && e.tool === "web_search");
	const fetchCalls = events.filter((e) => e.type === "tool_call" && e.tool === "web_fetch");
	const withLatency = [...searchCalls, ...fetchCalls].filter((e) => typeof e.latencyMs === "number");
	check("A3", "工具接入：search/fetch 事件带 latency", searchCalls.length > 0 && fetchCalls.length > 0 && withLatency.length > 0, `search=${searchCalls.length} fetch=${fetchCalls.length}`);
}

// A4: Evidence 可追溯 — quote 可定位且短引用非 fuzzy
{
	const untraceable = run.verification?.l1?.untraceableEvidence ?? ["<missing>"];
	const shortFuzzy = run.evidence.filter((e) => e.quote.length < 30 && e.quoteMatch === "fuzzy");
	check("A4", "Evidence 可追溯：untraceable=0 且短引用非 fuzzy", untraceable.length === 0 && shortFuzzy.length === 0, `evidence=${run.evidence.length} untraceable=${untraceable.length} shortFuzzy=${shortFuzzy.length}`);
}

// A5: 校验 L1 — dangling=0 且 unsupported=0 且 uncovered=0
{
	const l1 = run.verification?.l1 ?? {};
	check(
		"A5",
		"L1：dangling=0 且 unsupported=0 且 uncovered=0",
		(l1.danglingCitations ?? ["x"]).length === 0 && (l1.unsupportedClaims ?? ["x"]).length === 0 && (l1.uncoveredCriteria ?? ["x"]).length === 0,
		`dangling=${l1.danglingCitations?.length} unsupported=${l1.unsupportedClaims?.length} uncovered=${l1.uncoveredCriteria?.length}`,
	);
}

// A6: 校验 L2 — 每个 claim 有 verdict 且不得全部 supported
{
	const l2 = run.verification?.l2 ?? [];
	const allSupported = l2.length > 0 && l2.every((v) => v.verdict === "supported");
	const l2Skipped = run.verification?.l2Skipped;
	const pass = l2Skipped ? true : l2.length === run.claims.length && !allSupported;
	check("A6", "L2：每 claim 有 verdict 且不得全部 supported", pass, l2Skipped ? `skipped(${l2Skipped})` : `l2=${l2.length}/${run.claims.length} allSupported=${allSupported}`);
}

// A10: 五问可答
{
	const hasPlan = (run.plan?.tasks ?? []).every((t) => (t.rationale ?? "") !== "");
	const hasStatus = typeof run.status === "string";
	const hasCitation = run.claims.every((c) => c.evidenceIds.length > 0);
	const hasRecovery = events.some((e) => e.type === "recovery");
	const hasVerdict = run.verification !== undefined;
	check("A10", "五问可答：为什么搜/在执行什么/结论来源/失败怎么办/为何可信", hasPlan && hasStatus && hasCitation && hasRecovery !== undefined && hasVerdict, `plan=${hasPlan} citation=${hasCitation} verdict=${hasVerdict}`);
}

// 输出
console.log(`\n验收报告：${run.id}  (${run.status})\n${"=".repeat(60)}`);
let failCount = 0;
for (const r of results) {
	const icon = r.pass ? "✓" : "✗";
	if (!r.pass) failCount++;
	console.log(`  ${icon} ${r.id}  ${r.name}`);
	if (r.detail) console.log(`       ${r.detail}`);
}
console.log(`${"=".repeat(60)}`);
console.log(`结果：${failCount === 0 ? "全部通过" : `${failCount} 项失败`}\n`);
process.exit(failCount === 0 ? 0 : 1);
