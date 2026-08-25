/**
 * 极简 .env 加载（clone 即用支持）。
 *
 * 用户 clone 仓库后把 API key 写进根目录 .env（已 gitignore），
 * 扩展激活时自动加载，无需手动 export/set。
 *
 * 规则（dotenv 子集，无变量展开）：
 *   - KEY=VALUE，# 开头为注释，忽略空行与非法行
 *   - 值两端的成对单/双引号剥离
 *   - 已存在的环境变量优先，.env 不覆盖
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 从指定文件加载 KEY=VALUE 到 process.env。返回实际写入的 key 列表（文件缺失跳过）。 */
export function loadDotEnv(paths: string[]): string[] {
	const loaded: string[] = [];
	for (const path of paths) {
		let text: string;
		try {
			text = readFileSync(path, "utf8");
		} catch {
			continue; // 文件不存在是正常情况（用户可能走 export）
		}
		for (const line of text.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (trimmed === "" || trimmed.startsWith("#")) continue;
			const eq = trimmed.indexOf("=");
			if (eq <= 0) continue;
			const key = trimmed.slice(0, eq).trim();
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
			let value = trimmed.slice(eq + 1).trim();
			const first = value[0];
			if ((first === '"' || first === "'") && value[value.length - 1] === first) {
				value = value.slice(1, -1);
			}
			if (process.env[key] === undefined) {
				process.env[key] = value;
				loaded.push(key);
			}
		}
	}
	return loaded;
}

/** 扩展默认加载点：进程 cwd 与扩展包根目录下的 .env（后者覆盖从其他目录启动 pi 的场景）。 */
export function loadDotEnvDefault(): string[] {
	const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
	return loadDotEnv([join(process.cwd(), ".env"), join(packageRoot, ".env")]);
}
