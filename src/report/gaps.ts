/**
 * 研究空白章节（PRD §8.1 / gaps.ts）。
 *
 * 由代码确定性生成，不交给 Reporter LLM。
 * 诚实报告"没查到"比编造填充有价值——没有 Evidence 就不该有 Claim。
 * detail/lastError 可能含外部内容，渲染前过 escapeMarkdown。
 */

import { escapeMarkdown } from "../net/untrusted.ts";
import type { ResearchRun, Task } from "../types.ts";

const FAILURE_LABELS: Record<string, string> = {
	timeout: "多次请求超时",
	network: "网络连接失败",
	rate_limit: "搜索接口限流",
	http_4xx: "目标页面拒绝访问",
	http_5xx: "目标服务器错误",
	parse_error: "页面正文提取失败",
	blocked_url: "目标地址被安全策略拦截",
	no_search_result: "多次搜索无有效结果",
	all_fetch_failed: "候选页面均抓取失败",
	insufficient_evidence: "证据数量不足",
	quote_unverifiable: "摘录内容无法在原文定位",
	task_exception: "执行异常",
	repeated_task_failure: "多个关联任务失败",
	budget_exceeded: "预算耗尽",
	verification_failed: "校验未通过",
};

function gapReason(run: ResearchRun, task: Task): string {
	// 优先：该 task 最后一条 gaveUp 的 recovery 的 failureType → 人性化短语
	const gaveUp = [...run.recoveries].reverse().find((r) => r.taskId === task.id && r.outcome === "gaveUp");
	if (gaveUp) {
		const label = FAILURE_LABELS[gaveUp.failureType] ?? gaveUp.failureType;
		return `${label}（尝试 ${task.attempts} 次）`;
	}
	// 回退：status 语义
	if (task.status === "failed") {
		const detail = task.lastError ? `：${escapeMarkdown(task.lastError.slice(0, 80))}` : "";
		return `执行异常${detail}`;
	}
	if (task.evidenceCount > 0 && task.evidenceCount < task.minEvidence) {
		return `仅获 ${task.evidenceCount} 条证据（最低需 ${task.minEvidence} 条）`;
	}
	return `未能获得充分证据（尝试 ${task.attempts} 次）`;
}

function criteriaText(run: ResearchRun, task: Task): string {
	const brief = run.brief;
	if (!brief) return "";
	const texts = task.criterionIds
		.map((id) => brief.successCriteria.find((sc) => sc.id === id)?.text)
		.filter((t): t is string => t !== undefined);
	return texts.length > 0 ? `（影响判据：${texts.join("、")}）` : "";
}

/**
 * 生成研究空白章节。
 * 分两组：执行过但失败的（unresolved/failed）、因预算中断未执行的（pending）。
 */
export function renderGaps(run: ResearchRun): string {
	const tasks = run.plan?.tasks ?? [];
	const failed = tasks.filter((t) => t.status === "unresolved" || t.status === "failed");
	const pending = tasks.filter((t) => t.status === "pending");

	if (failed.length === 0 && pending.length === 0) return "";

	const lines: string[] = ["## 研究空白", ""];
	if (failed.length > 0) {
		lines.push("以下问题未能获得充分证据，本报告结论不覆盖这些方面：", "");
		for (const task of failed) {
			lines.push(`- **${escapeMarkdown(task.title)}**：${gapReason(run, task)}${criteriaText(run, task)}`);
		}
	}
	if (pending.length > 0) {
		if (failed.length > 0) lines.push("");
		lines.push("以下任务因预算或时间限制未执行：", "");
		for (const task of pending) {
			lines.push(`- **${escapeMarkdown(task.title)}**${criteriaText(run, task)}`);
		}
	}
	return lines.join("\n");
}
