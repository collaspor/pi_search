/**
 * Checkpoint（PRD §4.0.1 / §8.5）。
 *
 * 磁盘布局：
 *   <runDir>/run.json       权威状态快照（原子覆写）
 *   <runDir>/events.jsonl   事件流（append-only）
 *
 * 写入纪律（顺序不可颠倒）：
 *   1. appendEvent()  先落事件
 *   2. writeSnapshot() 再覆写快照
 * 崩溃发生在两步之间 → 事件已落盘、快照是旧的 → 恢复时重放补齐。
 * 反过来会出现"快照声称完成但事件流无记录"的不可审计状态。
 *
 * 原子写：先写 <file>.tmp 再 rename。rename 在 Windows 与 POSIX 上
 * 对同卷文件都是原子操作，崩溃只会留下 .tmp 残文件，不会损坏 run.json。
 */

import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ResearchEvent, ResearchEventPayload, ResearchRun } from "../types.ts";

export class CheckpointStore {
	readonly runDir: string;
	private seq: number;
	private readonly runId: string;

	private constructor(runDir: string, runId: string, lastSeq: number) {
		this.runDir = runDir;
		this.runId = runId;
		this.seq = lastSeq;
	}

	static async create(runDir: string, runId: string): Promise<CheckpointStore> {
		await mkdir(runDir, { recursive: true });
		return new CheckpointStore(runDir, runId, 0);
	}

	/** 恢复场景：从已有 run 的 lastSeq 继续编号 */
	static async open(runDir: string, run: ResearchRun): Promise<CheckpointStore> {
		await mkdir(runDir, { recursive: true });
		return new CheckpointStore(runDir, run.id, run.lastSeq);
	}

	get runPath(): string {
		return join(this.runDir, "run.json");
	}
	get eventsPath(): string {
		return join(this.runDir, "events.jsonl");
	}
	sourceBodyPath(sourceId: string): string {
		return join(this.runDir, "sources", `${sourceId}.txt`);
	}

	/** 分配下一个事件序号 */
	nextSeq(): number {
		return ++this.seq;
	}

	get currentSeq(): number {
		return this.seq;
	}

	/** 追加一条事件。seq 由本 store 单点分配，保证单调递增。 */
	async appendEvent(payload: ResearchEventPayload): Promise<ResearchEvent> {
		const event = {
			...payload,
			seq: this.nextSeq(),
			ts: Date.now(),
			runId: this.runId,
		} as ResearchEvent;
		await appendFile(this.eventsPath, `${JSON.stringify(event)}\n`, "utf8");
		return event;
	}

	/** 原子覆写快照。调用方负责把 run.lastSeq 更新为 currentSeq 后再调用。 */
	async writeSnapshot(run: ResearchRun): Promise<void> {
		const tmpPath = `${this.runPath}.tmp`;
		await writeFile(tmpPath, JSON.stringify(run, null, "\t"), "utf8");
		await rename(tmpPath, this.runPath);
	}

	/** 落盘一个 source 正文（quote 定位校验与 resume 后复检所需） */
	async writeSourceBody(sourceId: string, body: string): Promise<string> {
		const path = this.sourceBodyPath(sourceId);
		await mkdir(dirname(path), { recursive: true });
		const tmpPath = `${path}.tmp`;
		await writeFile(tmpPath, body, "utf8");
		await rename(tmpPath, path);
		return path;
	}

	async readSourceBody(sourceId: string): Promise<string | undefined> {
		try {
			return await readFile(this.sourceBodyPath(sourceId), "utf8");
		} catch {
			return undefined;
		}
	}
}

// ============================================================================
// 工具函数
// ============================================================================

/** 事件参数规范化哈希，用作幂等键（重放时判断工具调用是否已成功） */
export function hashArgs(args: unknown): string {
	return createHash("sha256").update(stableStringify(args)).digest("hex").slice(0, 16);
}

/** 确定性序列化：对象键排序，保证同参数同哈希 */
export function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const obj = value as Record<string, unknown>;
	const keys = Object.keys(obj).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** 读取并解析 events.jsonl（不存在的文件返回空数组） */
export async function readEvents(eventsPath: string): Promise<ResearchEvent[]> {
	let text: string;
	try {
		text = await readFile(eventsPath, "utf8");
	} catch {
		return [];
	}
	const events: ResearchEvent[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		events.push(JSON.parse(trimmed) as ResearchEvent);
	}
	return events;
}
