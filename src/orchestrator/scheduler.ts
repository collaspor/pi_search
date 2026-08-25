/**
 * Task 调度器（PRD §4.3）。
 *
 * 按 dependsOn 拓扑分层，同层用信号量并发。V1 默认 concurrency=1
 * （等于串行，符合上游文档"第一阶段可先串行"），调大即并发。
 * 循环依赖直接抛错（规划阶段就该杜绝，这里是最后一道防线）。
 */

import type { Task } from "../types.ts";

export class ScheduleError extends Error {}

/** 拓扑分层：第 0 层无依赖，第 n 层依赖全部在前 n-1 层。 */
export function topologicalLayers(tasks: Task[]): Task[][] {
	const byId = new Map(tasks.map((t) => [t.id, t]));
	const layerOf = new Map<string, number>();
	const visiting = new Set<string>();

	const layer = (task: Task): number => {
		const cached = layerOf.get(task.id);
		if (cached !== undefined) return cached;
		if (visiting.has(task.id)) {
			throw new ScheduleError(`circular dependency detected at task ${task.id}`);
		}
		visiting.add(task.id);
		let depth = 0;
		for (const depId of task.dependsOn) {
			const dep = byId.get(depId);
			if (!dep) throw new ScheduleError(`task ${task.id} depends on unknown task ${depId}`);
			depth = Math.max(depth, layer(dep) + 1);
		}
		visiting.delete(task.id);
		layerOf.set(task.id, depth);
		return depth;
	};

	for (const task of tasks) layer(task);

	const layers: Task[][] = [];
	for (const task of tasks) {
		const depth = layerOf.get(task.id) ?? 0;
		while (layers.length <= depth) layers.push([]);
		layers[depth].push(task);
	}
	return layers;
}

/** 信号量并发执行（同层任务）。concurrency=1 时退化为串行。 */
export async function runWithConcurrency<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results = new Array<TOut>(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}
