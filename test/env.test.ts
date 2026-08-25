/**
 * .env 加载测试：KEY=VALUE 解析、引号剥离、注释跳过、不覆盖已有变量、缺文件静默。
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadDotEnv } from "../src/env.ts";

let dir: string;
const touched: string[] = [];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "pi-research-env-"));
});

afterEach(async () => {
	for (const key of touched) delete process.env[key];
	touched.length = 0;
	await rm(dir, { recursive: true, force: true });
});

async function writeEnv(content: string): Promise<string> {
	const path = join(dir, ".env");
	await writeFile(path, content, "utf8");
	return path;
}

describe("loadDotEnv", () => {
	it("加载 KEY=VALUE，跳过注释与空行，剥离成对引号", async () => {
		const path = await writeEnv(
			[
				"# comment",
				"",
				"TEST_ENV_A=plain",
				'TEST_ENV_B="double quoted"',
				"TEST_ENV_C='single quoted'",
				"  TEST_ENV_D = spaced  ",
				"not-a-valid-line",
				"1INVALID=skip",
			].join("\r\n"),
		);
		touched.push("TEST_ENV_A", "TEST_ENV_B", "TEST_ENV_C", "TEST_ENV_D");
		const loaded = loadDotEnv([path]);
		expect(loaded.sort()).toEqual(["TEST_ENV_A", "TEST_ENV_B", "TEST_ENV_C", "TEST_ENV_D"]);
		expect(process.env.TEST_ENV_A).toBe("plain");
		expect(process.env.TEST_ENV_B).toBe("double quoted");
		expect(process.env.TEST_ENV_C).toBe("single quoted");
		expect(process.env.TEST_ENV_D).toBe("spaced");
	});

	it("已存在的环境变量不被覆盖", async () => {
		process.env.TEST_ENV_KEEP = "real";
		touched.push("TEST_ENV_KEEP");
		const path = await writeEnv("TEST_ENV_KEEP=from-file");
		expect(loadDotEnv([path])).toEqual([]);
		expect(process.env.TEST_ENV_KEEP).toBe("real");
	});

	it("文件缺失静默跳过，不抛错", () => {
		expect(loadDotEnv([join(dir, "nonexistent.env")])).toEqual([]);
	});
});
