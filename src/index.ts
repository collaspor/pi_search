/**
 * Deep Research Agent — pi 扩展入口。
 *
 * M1 安全与骨架 / M2 校验内核 / M3 理解与规划。
 * 研究执行（researching）在 M4 接入。
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { orchestrate } from "./orchestrator/run.ts";
import type { ResearchBrief } from "./types.ts";

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
					"研究与报告将在后续里程碑接入。",
				];
				pi.sendMessage({ customType: "research-result", display: true, content: lines.join("\n") });
			} catch (err) {
				pi.sendMessage({
					customType: "research-error",
					display: true,
					content: `[research] 执行失败：${err instanceof Error ? err.message : String(err)}`,
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
