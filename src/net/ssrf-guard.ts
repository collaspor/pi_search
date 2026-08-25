/**
 * SSRF 防护（PRD §9.1）。
 *
 * web_fetch 接受模型生成的 URL，是教科书级 SSRF 入口。本模块实现：
 * 1. 协议白名单（仅 http/https）
 * 2. DNS 解析后校验 IP（不能只看域名字符串）
 * 3. 私有/保留网段拒绝（含项目安全规则额外要求的 9/11/21/30.*）
 * 4. 端口限制
 *
 * 重定向逐跳校验在 http.ts 的 fetch 循环中调用 checkUrl 实现。
 * DNS 解析函数可注入，便于单元测试（mock DNS）与 DNS rebinding 缓解。
 */

import { promises as dns } from "node:dns";
import { isIP } from "node:net";

export interface SsrfCheckOk {
	ok: true;
	hostname: string;
	port: number;
	addresses: string[];
}

export interface SsrfCheckFail {
	ok: false;
	reason: string;
}

export type SsrfResult = SsrfCheckOk | SsrfCheckFail;

/** 返回解析后的 IP 字符串列表。可注入 mock 用于测试。 */
export type LookupFn = (hostname: string) => Promise<string[]>;

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const ALLOWED_PORTS = new Set([80, 443, 8080, 8443]);

const defaultLookup: LookupFn = async (hostname) => {
	const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
	return addresses.map((a) => a.address);
};

// ============================================================================
// IPv4 判定
// ============================================================================

/** 严格解析点分十进制 IPv4，返回 4 个字节；非法返回 undefined。 */
export function parseIpv4(ip: string): [number, number, number, number] | undefined {
	const parts = ip.split(".");
	if (parts.length !== 4) return undefined;
	const bytes: number[] = [];
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return undefined;
		const n = Number(part);
		if (n > 255) return undefined;
		bytes.push(n);
	}
	return bytes as [number, number, number, number];
}

/** IPv4 是否属于私有/保留/被项目规则拒绝的网段。 */
export function isDeniedIpv4(ip: string): boolean {
	const b = parseIpv4(ip);
	if (!b) return false; // 非 IPv4 交给调用方按 IPv6 处理
	const [a, bb] = b;
	if (a === 0) return true; // 0.0.0.0/8 "this network"
	if (a === 10) return true; // 10.0.0.0/8 私网
	if (a === 127) return true; // 127.0.0.0/8 回环
	if (a === 169 && bb === 254) return true; // 169.254.0.0/16 链路本地（云元数据）
	if (a === 172 && bb >= 16 && bb <= 31) return true; // 172.16.0.0/12 私网
	if (a === 192 && bb === 0 && b[2] === 0) return true; // 192.0.0.0/24 IETF 协议分配
	if (a === 192 && bb === 168) return true; // 192.168.0.0/16 私网
	if (a === 198 && (bb === 18 || bb === 19)) return true; // 198.18.0.0/15 基准测试
	if (a === 100 && bb >= 64 && bb <= 127) return true; // 100.64.0.0/10 CGNAT
	if (a >= 224 && a <= 239) return true; // 224.0.0.0/4 组播
	if (a >= 240) return true; // 240.0.0.0/4 保留 + 255 广播
	// 项目安全规则额外拒绝的网段
	if (a === 9 || a === 11 || a === 21 || a === 30) return true;
	return false;
}

// ============================================================================
// IPv6 判定
// ============================================================================

/**
 * 把 IPv6 地址解析为 16 字节。支持 "::" 压缩与嵌入式点分 IPv4。
 * 非法返回 undefined。
 */
export function parseIpv6(ip: string): number[] | undefined {
	let input = ip.toLowerCase();
	// 去掉 zone id（fe80::1%eth0）
	const zoneIdx = input.indexOf("%");
	if (zoneIdx !== -1) input = input.slice(0, zoneIdx);

	// 嵌入式 IPv4（如 ::ffff:127.0.0.1）：转成十六进制尾段
	if (input.includes(".")) {
		const lastColon = input.lastIndexOf(":");
		if (lastColon === -1) return undefined;
		const v4 = parseIpv4(input.slice(lastColon + 1));
		if (!v4) return undefined;
		const hi = ((v4[0] << 8) | v4[1]).toString(16);
		const lo = ((v4[2] << 8) | v4[3]).toString(16);
		input = `${input.slice(0, lastColon)}:${hi}:${lo}`;
	}

	const hasCompression = input.includes("::");
	if (hasCompression && input.indexOf("::") !== input.lastIndexOf("::")) return undefined;

	const [leftRaw, rightRaw] = hasCompression ? input.split("::") : [input, undefined];
	const left = leftRaw.length > 0 ? leftRaw.split(":") : [];
	const right = rightRaw !== undefined && rightRaw.length > 0 ? rightRaw.split(":") : [];

	for (const group of [...left, ...right]) {
		if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined;
	}

	const totalGroups = left.length + right.length;
	if (hasCompression) {
		if (totalGroups > 7) return undefined;
	} else if (totalGroups !== 8) {
		return undefined;
	}

	const groups: number[] = [];
	for (const g of left) groups.push(Number.parseInt(g, 16));
	if (hasCompression) {
		const missing = 8 - totalGroups;
		for (let i = 0; i < missing; i++) groups.push(0);
	}
	for (const g of right) groups.push(Number.parseInt(g, 16));
	if (groups.length !== 8) return undefined;

	const bytes: number[] = [];
	for (const g of groups) {
		bytes.push((g >> 8) & 0xff, g & 0xff);
	}
	return bytes;
}

/** IPv4-mapped IPv6（::ffff:0:0/96）的内嵌 IPv4，非映射返回 undefined。 */
function mappedIpv4(bytes: number[]): string | undefined {
	for (let i = 0; i < 10; i++) if (bytes[i] !== 0) return undefined;
	if (bytes[10] !== 0xff || bytes[11] !== 0xff) return undefined;
	return `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
}

/** NAT64 well-known prefix 64:ff9b::/96 的内嵌 IPv4，非 NAT64 返回 undefined。 */
function nat64Ipv4(bytes: number[]): string | undefined {
	if (bytes[0] !== 0x00 || bytes[1] !== 0x64) return undefined;
	if (bytes[2] !== 0xff || bytes[3] !== 0x9b) return undefined;
	for (let i = 4; i < 8; i++) if (bytes[i] !== 0) return undefined;
	return `${bytes[8]}.${bytes[9]}.${bytes[10]}.${bytes[11]}`;
}

/** IPv6 是否属于拒绝范围。 */
export function isDeniedIpv6(ip: string): boolean {
	const bytes = parseIpv6(ip);
	if (!bytes) return false;

	// IPv4-mapped / NAT64：解出内层 IPv4 再按 v4 规则校验
	const v4 = mappedIpv4(bytes) ?? nat64Ipv4(bytes);
	if (v4 !== undefined) return isDeniedIpv4(v4);

	const allZero = bytes.every((b) => b === 0);
	if (allZero) return true; // :: 未指定地址

	const isLoopback = bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1;
	if (isLoopback) return true; // ::1 回环

	if ((bytes[0] & 0xfe) === 0xfc) return true; // fc00::/7 ULA
	if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // fe80::/10 链路本地

	// 隧道过渡机制会封装内层 IPv4，保守起见不解析直接拒绝
	if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0 && bytes[3] === 0) return true; // 2001::/32 Teredo
	if (bytes[0] === 0x20 && bytes[1] === 0x02) return true; // 2002::/16 6to4

	return false;
}

/** 任意 IP 字面量是否被拒绝。 */
export function isDeniedIp(ip: string): boolean {
	if (ip.includes(".")) return isDeniedIpv4(ip);
	return isDeniedIpv6(ip);
}

// ============================================================================
// URL 校验
// ============================================================================

export interface CheckUrlOptions {
	lookup?: LookupFn;
}

/**
 * 校验一个 URL 是否允许抓取。
 * URL 解析遵循 WHATWG 规范，非标准 IPv4 形式（整数、十六进制、八进制）
 * 会被 new URL 归一化为标准点分形式后再校验。
 */
export async function checkUrl(rawUrl: string, options?: CheckUrlOptions): Promise<SsrfResult> {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		return { ok: false, reason: `unparseable URL: ${rawUrl}` };
	}

	if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
		return { ok: false, reason: `protocol not allowed: ${url.protocol}` };
	}

	const defaultPort = url.protocol === "https:" ? 443 : 80;
	const port = url.port === "" ? defaultPort : Number(url.port);
	if (!ALLOWED_PORTS.has(port)) {
		return { ok: false, reason: `port not allowed: ${port}` };
	}

	let hostname = url.hostname;
	// IPv6 字面量的 hostname 带方括号
	if (hostname.startsWith("[") && hostname.endsWith("]")) {
		hostname = hostname.slice(1, -1);
	}
	if (hostname === "") {
		return { ok: false, reason: "empty hostname" };
	}

	// IP 字面量直接校验，跳过 DNS
	const ipVersion = isIP(hostname);
	if (ipVersion !== 0) {
		if (isDeniedIp(hostname)) {
			return { ok: false, reason: `IP literal is in a denied range: ${hostname}` };
		}
		return { ok: true, hostname, port, addresses: [hostname] };
	}

	// 域名：DNS 解析后逐个校验
	const lookup = options?.lookup ?? defaultLookup;
	let addresses: string[];
	try {
		addresses = await lookup(hostname);
	} catch (err) {
		return {
			ok: false,
			reason: `DNS resolution failed for ${hostname}: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	if (addresses.length === 0) {
		return { ok: false, reason: `DNS returned no addresses for ${hostname}` };
	}
	for (const address of addresses) {
		if (isDeniedIp(address)) {
			return { ok: false, reason: `${hostname} resolves to denied address ${address}` };
		}
	}
	return { ok: true, hostname, port, addresses };
}
