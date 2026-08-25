/**
 * Trace 树渲染（PRD §8.6 失败可观测）。
 *
 * 从 run.json + events.jsonl 重建执行轨迹树，/research:status 使用。
 * 格式（PRD 钦定）：
 *   [1] Comprehend   ✓  1.2s  ↑1.1k ↓380   5 criteria
 *   [3] Research
 *       T1 市场规模   ✓  28s   3 evidence
 *          └─ timeout  ↻ retry 2/3 → recovered
 */

import type { ResearchEvent, ResearchRun } from "../types.ts";

function fmtTokens(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 1000000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1000000).toFixed(1)}M`;
}

function fmtDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

const PHASE_LABELS: Record<string, string> = {
	comprehending: "Comprehend",
	planning: "Plan",
	researching: "Research",
	reporting: "Report",
	verifying: "Verify",
};

/** 从事件流提取每个 Task 的工具调用与恢复记录 */
interface TaskTrace {
	toolCalls: { tool: string; latencyMs: number; ok: boolean; failureType?: string }[];
	recoveries: { failureType: string; strategy: string; attempt: number; outcome: string }[];
	startedAt?: number;
	finishedAt?: number;
}

function buildTaskTraces(events: ResearchEvent[]): Map<string, TaskTrace> {
	const traces = new Map<string, TaskTrace>();
	const get = (taskId: string): TaskTrace => {
		let t = traces.get(taskId);
		if (!t) {
			t = { toolCalls: [], recoveries: [] };
			traces.set(taskId, t);
		}
		return t;
	};
	for (const e of events) {
		if (e.type === "tool_call") {
			get(e.taskId).toolCalls.push({ tool: e.tool, latencyMs: e.latencyMs, ok: e.ok, failureType: e.failureType });
		} else if (e.type === "recovery" && e.event.taskId) {
			get(e.event.taskId).recoveries.push({
				failureType: e.event.failureType,
				strategy: e.event.strategy,
				attempt: e.event.attempt,
				outcome: e.event.outcome,
			});
		} else if (e.type === "task_start") {
			get(e.taskId).startedAt = e.ts;
		} else if (e.type === "task_end") {
			get(e.taskId).finishedAt = e.ts;
		}
	}
	return traces;
}

function statusIcon(status: string): string {
	switch (status) {
		case "success":
			return "✓";
		case "unresolved":
			return "⚠";
		case "failed":
			return "✗";
		case "running":
			return "⏳";
		default:
			return "·";
	}
}

const FAILURE_LABELS: Record<string, string> = {
	timeout: "timeout",
	network: "network",
	rate_limit: "rate_limit",
	http_4xx: "http_4xx",
	http_5xx: "http_5xx",
	parse_error: "parse_error",
	blocked_url: "blocked_url",
	no_search_result: "no_result",
	all_fetch_failed: "all_fetch_failed",
	insufficient_evidence: "insufficient",
	quote_unverifiable: "quote_rejected",
	task_exception: "exception",
	repeated_task_failure: "repeated_failure",
	budget_exceeded: "budget",
	verification_failed: "verify_failed",
};

/** 渲染一个 run 的 Trace 树 */
export function renderTrace(run: ResearchRun, events: ResearchEvent[]): string {
	const lines: string[] = [];
	const statusLabel = run.status === "completed" ? "completed" : run.status;
	lines.push(`Research Run ${run.id}  (${statusLabel})`);
	lines.push(`Query: ${run.query}`);
	lines.push("");

	const taskTraces = buildTaskTraces(events);
	const phases: string[] = ["comprehending", "planning", "researching", "reporting", "verifying"];
	let phaseNum = 0;

	// 阶段耗时（从 phase_enter 事件推算）
	const phaseEvents = events.filter((e) => e.type === "phase_enter");

	for (const phase of phases) {
		const hasPhase = phaseEvents.some((e) => e.type === "phase_enter" && e.phase === phase);
		if (!hasPhase && phase !== "researching") continue;
		phaseNum++;
		const label = `${"    [P]".slice(0, 0)}[${phaseNum}] ${PHASE_LABELS[phase] ?? phase}`;

		if (phase === "researching") {
			lines.push(`${label}`);
			const tasks = run.plan?.tasks ?? [];
			for (const task of tasks) {
				const trace = taskTraces.get(task.id);
				const icon = statusIcon(task.status);
				const duration =
					trace?.startedAt && trace.finishedAt ? fmtDuration(trace.finishedAt - trace.startedAt) : "";
				const toolCount = trace?.toolCalls.length ?? 0;
				lines.push(
					`    ${task.id} ${task.title.slice(0, 28).padEnd(30)} ${icon}  ${duration.padEnd(7)} ${task.evidenceCount} evidence${toolCount > 0 ? ` (${toolCount} calls)` : ""}`,
				);
				for (const rec of trace?.recoveries ?? []) {
					const icon2 = rec.outcome === "recovered" ? "↻" : rec.outcome === "degraded" ? "↘" : "✗";
					lines.push(
						`       └─ ${FAILURE_LABELS[rec.failureType] ?? rec.failureType}  ${icon2} ${rec.strategy} → ${rec.outcome}`,
					);
				}
			}
		} else if (phase === "verifying") {
			const v = run.verification;
			if (v) {
				const l1Note = v.l1.passed ? "✓" : "⚠";
				lines.push(
					`${label}  L1 ${l1Note}  0 dangling, coverage ${v.l1.coverage.filter((c) => c.claimCount > 0).length}/${v.l1.coverage.length}`,
				);
				if (v.l2Skipped) lines.push(`             L2 ·  skipped (${v.l2Skipped})`);
				else if (v.l2.length > 0) {
					const counts = { supported: 0, unsupported: 0, conflicting: 0, uncertain: 0 };
					for (const x of v.l2) counts[x.verdict]++;
					lines.push(
						`             L2 ✓  ${counts.supported} supported / ${counts.conflicting} conflicting / ${counts.uncertain} uncertain / ${counts.unsupported} unsupported`,
					);
				}
			} else {
				lines.push(label);
			}
		} else {
			const meta =
				phase === "comprehending" && run.brief
					? `  ${run.brief.successCriteria.length} criteria`
					: phase === "planning" && run.plan
						? `  ${run.plan.tasks.length} tasks`
						: phase === "reporting"
							? `  ${run.claims.length} claims`
							: "";
			lines.push(`${label}${meta}`);
		}
	}

	// 汇总
	lines.push("");
	const recoveriesCount = run.recoveries.length;
	const recovered = run.recoveries.filter((r) => r.outcome === "recovered").length;
	const gaveUp = run.recoveries.filter((r) => r.outcome === "gaveUp").length;
	const wallMs = run.updatedAt - run.createdAt;
	lines.push(
		`Total  ${fmtDuration(wallMs)}   ↑${fmtTokens(run.budget.usedTokens)}   $${run.budget.usedCostUsd.toFixed(4)}   ${recoveriesCount > 0 ? `${recoveriesCount} recoveries (${recovered} recovered, ${gaveUp} gaveUp)` : "no failures"}`,
	);
	lines.push(`Report: .codebuddy/research/${run.id}/report.md`);
	return lines.join("\n");
}

/** /research:list 的单行摘要 */
export function renderRunListItem(run: ResearchRun): string {
	const date = new Date(run.createdAt).toISOString().slice(0, 16).replace("T", " ");
	return `${run.id}  [${run.status}]  ${date}  ${run.evidence.length}证据/${run.claims.length}结论  ${run.query.slice(0, 50)}`;
}
