/**
 * Deep Research Agent — pi 扩展入口。
 *
 * 全流程：理解 → 规划 → 研究 → 报告 → L1+L2 校验 / 失败兜底 / 断点续跑。
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { renderRunListItem, renderTrace } from "./observability/trace.ts";
import { readEvents } from "./orchestrator/checkpoint.ts";
import { orchestrate, resumeRun } from "./orchestrator/run.ts";
import type { ResearchBrief, ResearchRun } from "./types.ts";

function formatBrief(brief: ResearchBrief): string {
	const lines: string[] = [
		`目标：${brief.goal}`,
		"",
		`范围：包含 ${brief.scope.included.join(" / ") || "(未指定)"}`,
		`      排除 ${brief.scope.excluded.join(" / ") || "(无)"}`,
	];
	if (brief.entities.length > 0) lines.push(`实体：${brief.entities.join("、")}`);
	if (brief.timeRange) lines.push(`时间：${brief.timeRange.from ?? "?"} ~ ${brief.timeRange.to ?? "?"}`);
	lines.push("", "判据：");
	for (const sc of brief.successCriteria) {
		lines.push(`  ${sc.id} ${sc.text}`);
	}
	if (brief.assumptions.length > 0) {
		lines.push("", "假设：");
		for (const a of brief.assumptions) lines.push(`  - ${a}`);
	}
	lines.push("", `章节：${brief.outline.join(" → ")}`);
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("research-no-confirm", {
		description: "Skip the brief confirmation step for /research",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("research-budget-usd", {
		description: "Cost budget in USD for a research run",
		type: "string",
		default: "2.0",
	});

	pi.registerCommand("research", {
		description: "Deep research: comprehend → plan → gather evidence → verified report (M3: comprehend+plan)",
		handler: async (args, ctx) => {
			const query = args.trim();
			if (query === "") {
				pi.sendMessage({
					customType: "research-error",
					display: true,
					content: "用法：/research <研究问题>",
				});
				return;
			}
			if (!ctx.model) {
				pi.sendMessage({
					customType: "research-error",
					display: true,
					content: "未选择模型。请先用 /model 选择模型后再运行 /research。",
				});
				return;
			}

			const noConfirm = pi.getFlag("research-no-confirm") === true;
			const budgetFlag = pi.getFlag("research-budget-usd");
			const budgetUsd = typeof budgetFlag === "string" ? Number.parseFloat(budgetFlag) : 2.0;
			const progress = (text: string) => {
				pi.sendMessage({ customType: "research-progress", display: true, content: `[research] ${text}` });
			};

			// 经 pi 凭据体系解析 LLM 认证：环境变量 / OAuth 订阅都走这里
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
			if (!auth.ok) {
				pi.sendMessage({
					customType: "research-error",
					display: true,
					content: `[research] 无法解析模型凭据：${auth.error}\n请配置环境变量（如 DEEPSEEK_API_KEY）或用 pi /login 登录。`,
				});
				return;
			}

			try {
				const result = await orchestrate({
					query,
					model: ctx.model,
					cwd: ctx.cwd,
					signal: ctx.signal,
					onProgress: progress,
					confirmBrief: buildConfirmBrief(ctx, noConfirm),
					budgetUsd: Number.isFinite(budgetUsd) ? budgetUsd : 2.0,
					apiKey: auth.apiKey,
					headers: auth.headers as Record<string, string> | undefined,
				});

				const { run, runDir, cancelled } = result;
				if (cancelled) {
					progress(`已取消。产物保留在 ${runDir}`);
					return;
				}

				const tasks = run.plan?.tasks ?? [];
				const lines = [
					`[research] 规划完成（${run.id}）`,
					"",
					formatBrief(run.brief!),
					"",
					"任务：",
					...tasks.map((t) => `  ${t.id} ${t.title}  [${t.criterionIds.join(",")}]`),
					"",
					`产物目录：${runDir}`,
					`状态：${run.status}`,
					`报告：${join(runDir, "report.md")}`,
				];
				pi.sendMessage({ customType: "research-result", display: true, content: lines.join("\n") });
				// print 模式下 sendMessage 不可见，终态额外写 stderr 保证可见
				if (!ctx.hasUI) {
					console.error(
						`[research] ${run.status}：${run.claims.length} 条结论，报告 ${join(runDir, "report.md")}`,
					);
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				pi.sendMessage({
					customType: "research-error",
					display: true,
					content: `[research] 执行失败：${message}`,
				});
				// print 模式失败必须可见（修复：之前静默退出无任何提示）
				console.error(`[research] 执行失败：${message}`);
			}
		},
	});

	// ── /research:status [runId]：Trace 树 ─────────────────────
	pi.registerCommand("research:status", {
		description: "Show the execution trace of a research run (latest if no id given)",
		handler: async (args, ctx) => {
			try {
				const base = join(ctx.cwd, ".codebuddy", "research");
				let runId = args.trim();
				if (runId === "") {
					const dirs = (await readdir(base, { withFileTypes: true }))
						.filter((d) => d.isDirectory())
						.map((d) => d.name)
						.sort();
					runId = dirs[dirs.length - 1];
					if (!runId) {
						pi.sendMessage({ customType: "research-error", display: true, content: "还没有任何 research run。" });
						return;
					}
				}
				const runDir = join(base, runId);
				const run = JSON.parse(await readFile(join(runDir, "run.json"), "utf8")) as ResearchRun;
				const events = await readEvents(join(runDir, "events.jsonl"));
				pi.sendMessage({ customType: "research-trace", display: true, content: renderTrace(run, events) });
			} catch (err) {
				pi.sendMessage({
					customType: "research-error",
					display: true,
					content: `[research:status] ${err instanceof Error ? err.message : String(err)}`,
				});
			}
		},
	});

	// ── /research:list：列出全部 run ────────────────────────────
	pi.registerCommand("research:list", {
		description: "List all research runs",
		handler: async (_args, ctx) => {
			try {
				const base = join(ctx.cwd, ".codebuddy", "research");
				const dirs = (await readdir(base, { withFileTypes: true }))
					.filter((d) => d.isDirectory())
					.map((d) => d.name)
					.sort();
				if (dirs.length === 0) {
					pi.sendMessage({ customType: "research-list", display: true, content: "还没有任何 research run。" });
					return;
				}
				const lines: string[] = [];
				for (const runId of dirs) {
					try {
						const run = JSON.parse(await readFile(join(base, runId, "run.json"), "utf8")) as ResearchRun;
						lines.push(renderRunListItem(run));
					} catch {
						lines.push(`${runId}  [损坏]`);
					}
				}
				pi.sendMessage({ customType: "research-list", display: true, content: lines.join("\n") });
			} catch (err) {
				pi.sendMessage({
					customType: "research-error",
					display: true,
					content: `[research:list] ${err instanceof Error ? err.message : String(err)}`,
				});
			}
		},
	});

	// ── /research:resume <runId>：断点续跑 ─────────────────────
	pi.registerCommand("research:resume", {
		description: "Resume an interrupted research run from its last checkpoint",
		handler: async (args, ctx) => {
			const runId = args.trim();
			if (runId === "") {
				pi.sendMessage({ customType: "research-error", display: true, content: "用法：/research:resume <runId>" });
				return;
			}
			if (!ctx.model) {
				pi.sendMessage({ customType: "research-error", display: true, content: "未选择模型。" });
				return;
			}
			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
			if (!auth.ok) {
				pi.sendMessage({
					customType: "research-error",
					display: true,
					content: `[research:resume] 无法解析模型凭据：${auth.error}`,
				});
				return;
			}
			const progress = (text: string) => {
				pi.sendMessage({ customType: "research-progress", display: true, content: `[research] ${text}` });
			};
			try {
				const result = await resumeRun({
					runId,
					query: "",
					model: ctx.model,
					cwd: ctx.cwd,
					signal: ctx.signal,
					onProgress: progress,
					apiKey: auth.apiKey,
					headers: auth.headers as Record<string, string> | undefined,
				});
				progress(`续跑结束：${result.run.status}。产物：${result.runDir}`);
			} catch (err) {
				pi.sendMessage({
					customType: "research-error",
					display: true,
					content: `[research:resume] ${err instanceof Error ? err.message : String(err)}`,
				});
			}
		},
	});
}

function buildConfirmBrief(
	ctx: ExtensionCommandContext,
	noConfirm: boolean,
): ((brief: ResearchBrief) => Promise<boolean>) | undefined {
	// 非交互模式（无 UI）自动继续：无人可确认，确认窗口不适用
	if (noConfirm || !ctx.hasUI) return undefined;
	return async (brief) => {
		return ctx.ui.confirm("确认研究简报（Enter 开始研究 / Esc 取消）", formatBrief(brief));
	};
}
