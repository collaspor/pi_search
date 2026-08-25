/**
 * SSRF 防护测试（PRD §9.1 / 验收 A8）。
 * DNS 全部 mock，不依赖真实网络。
 */

import { describe, expect, it } from "vitest";
import { checkUrl, isDeniedIp, isDeniedIpv4, isDeniedIpv6, parseIpv4, parseIpv6 } from "../src/net/ssrf-guard.ts";

/** mock DNS：hostname → 解析结果 */
function mockLookup(table: Record<string, string[]>) {
	return async (hostname: string): Promise<string[]> => {
		const addresses = table[hostname];
		if (!addresses) throw new Error(`ENOTFOUND ${hostname}`);
		return addresses;
	};
}

describe("parseIpv4", () => {
	it("解析合法地址", () => {
		expect(parseIpv4("127.0.0.1")).toEqual([127, 0, 0, 1]);
		expect(parseIpv4("0.0.0.0")).toEqual([0, 0, 0, 0]);
		expect(parseIpv4("255.255.255.255")).toEqual([255, 255, 255, 255]);
	});
	it("拒绝非法地址", () => {
		expect(parseIpv4("256.1.1.1")).toBeUndefined();
		expect(parseIpv4("1.2.3")).toBeUndefined();
		expect(parseIpv4("1.2.3.4.5")).toBeUndefined();
		expect(parseIpv4("a.b.c.d")).toBeUndefined();
		expect(parseIpv4("1.2.3.")).toBeUndefined();
	});
});

describe("parseIpv6", () => {
	it("解析完整与压缩形式", () => {
		expect(parseIpv6("::1")).toHaveLength(16);
		expect(parseIpv6("::")).toHaveLength(16);
		expect(parseIpv6("2001:db8::1")).toHaveLength(16);
		expect(parseIpv6("fe80::a634:d9ff:fe51:cf6c")).toHaveLength(16);
	});
	it("解析嵌入式 IPv4", () => {
		const bytes = parseIpv6("::ffff:127.0.0.1");
		expect(bytes).toBeDefined();
		expect(bytes?.slice(12)).toEqual([127, 0, 0, 1]);
	});
	it("拒绝非法地址", () => {
		expect(parseIpv6(":::1")).toBeUndefined();
		expect(parseIpv6("1:2:3:4:5:6:7:8:9")).toBeUndefined();
		expect(parseIpv6("::gggg")).toBeUndefined();
		expect(parseIpv6("12345::")).toBeUndefined();
	});
	it("去掉 zone id", () => {
		expect(parseIpv6("fe80::1%eth0")).toHaveLength(16);
	});
});

describe("isDeniedIpv4", () => {
	it.each([
		["0.0.0.1", "0.0.0.0/8"],
		["10.0.0.1", "10/8 私网"],
		["10.255.255.255", "10/8 私网"],
		["127.0.0.1", "回环"],
		["127.1.2.3", "回环"],
		["169.254.169.254", "链路本地/云元数据"],
		["172.16.0.1", "172.16/12 私网"],
		["172.31.255.255", "172.16/12 私网"],
		["192.0.0.1", "192.0.0.0/24"],
		["192.168.1.1", "192.168/16 私网"],
		["198.18.0.1", "198.18/15 基准测试"],
		["100.64.0.1", "100.64/10 CGNAT"],
		["100.127.255.255", "100.64/10 CGNAT"],
		["224.0.0.1", "组播"],
		["240.0.0.1", "保留"],
		["255.255.255.255", "广播"],
		["9.1.1.1", "项目规则 9.*"],
		["11.0.0.1", "项目规则 11.*"],
		["21.1.1.1", "项目规则 21.*"],
		["30.1.1.1", "项目规则 30.*"],
	])("拒绝 %s（%s）", (ip) => {
		expect(isDeniedIpv4(ip)).toBe(true);
	});
	it.each([
		["8.8.8.8", "公网 DNS"],
		["1.1.1.1", "公网 DNS"],
		["172.15.0.1", "172.16/12 之外"],
		["172.32.0.1", "172.16/12 之外"],
		["100.63.0.1", "100.64/10 之外"],
		["192.168.0.0 的边缘 192.167.0.1".split(" ").pop()!, "192.168/16 之外"],
		["198.17.0.1", "198.18/15 之外"],
	])("放行 %s（%s）", (ip) => {
		expect(isDeniedIpv4(ip)).toBe(false);
	});
});

describe("isDeniedIpv6", () => {
	it.each([
		["::1", "回环"],
		["::", "未指定"],
		["fc00::1", "ULA fc00::/7"],
		["fd12:3456::1", "ULA fc00::/7"],
		["fe80::1", "链路本地"],
		["febf::1", "链路本地 fe80::/10 上界"],
		["::ffff:127.0.0.1", "IPv4-mapped 回环"],
		["::ffff:10.0.0.1", "IPv4-mapped 私网"],
		["::ffff:169.254.169.254", "IPv4-mapped 云元数据"],
		["::ffff:9.1.1.1", "IPv4-mapped 项目规则"],
		["64:ff9b::7f00:1", "NAT64 回环（十六进制形式）"],
		["2001::1", "Teredo"],
		["2002:0a00:0001::1", "6to4 封装私网"],
	])("拒绝 %s（%s）", (ip) => {
		expect(isDeniedIpv6(ip)).toBe(true);
	});
	it.each([
		["2001:db8::1", "文档用公网"],
		["2606:4700:4700::1111", "Cloudflare DNS"],
		["::ffff:8.8.8.8", "IPv4-mapped 公网"],
		["fec0::1", "site-local 之外（fec0 不在 fe80::/10）"],
	])("放行 %s（%s）", (ip) => {
		expect(isDeniedIpv6(ip)).toBe(false);
	});
});

describe("checkUrl — 协议与端口", () => {
	it("拒绝非 http(s) 协议", async () => {
		for (const url of ["file:///etc/passwd", "gopher://evil.com/", "ftp://evil.com/x", "data:text/html,<script>"]) {
			const r = await checkUrl(url);
			expect(r.ok).toBe(false);
		}
	});
	it("拒绝危险端口", async () => {
		for (const url of ["http://example.com:22/", "http://example.com:3306/", "http://example.com:6379/"]) {
			const r = await checkUrl(url, { lookup: mockLookup({ "example.com": ["93.184.216.34"] }) });
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.reason).toContain("port");
		}
	});
	it("放行标准与允许的端口", async () => {
		const lookup = mockLookup({ "example.com": ["93.184.216.34"] });
		for (const url of [
			"http://example.com/",
			"https://example.com/",
			"https://example.com:8443/",
			"http://example.com:8080/",
		]) {
			const r = await checkUrl(url, { lookup });
			expect(r.ok).toBe(true);
		}
	});
	it("拒绝无法解析的 URL", async () => {
		const r = await checkUrl("not a url at all");
		expect(r.ok).toBe(false);
	});
});

describe("checkUrl — IP 字面量（验收 A8 点名用例）", () => {
	it.each([
		"http://169.254.169.254/latest/meta-data",
		"http://127.0.0.1:22/",
		"http://10.0.0.1/",
		"http://9.1.1.1/",
		"http://30.1.1.1/",
		"http://192.168.1.1/",
		"http://172.16.0.1/",
		"http://[::1]/",
		"http://[::ffff:127.0.0.1]/",
		"http://[::ffff:a00:1]/",
	])("拒绝 %s", async (url) => {
		const r = await checkUrl(url);
		expect(r.ok).toBe(false);
	});
	it("非标准 IPv4 形式被 URL 归一化后仍被拒绝", async () => {
		// 2130706433 = 127.0.0.1，0x7f000001 = 127.0.0.1
		for (const url of ["http://2130706433/", "http://0x7f000001/"]) {
			const r = await checkUrl(url);
			expect(r.ok).toBe(false);
		}
	});
	it("放行公网 IP 字面量", async () => {
		const r = await checkUrl("https://93.184.216.34/");
		expect(r.ok).toBe(true);
	});
});

describe("checkUrl — DNS 解析后校验", () => {
	it("域名解析到私网地址被拒绝", async () => {
		// evil.com 可以 A 记录指向 169.254.169.254
		const r = await checkUrl("http://evil.com/", {
			lookup: mockLookup({ "evil.com": ["169.254.169.254"] }),
		});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toContain("169.254.169.254");
	});
	it("多个解析结果中任一私网即拒绝", async () => {
		const r = await checkUrl("http://evil.com/", {
			lookup: mockLookup({ "evil.com": ["93.184.216.34", "10.0.0.1"] }),
		});
		expect(r.ok).toBe(false);
	});
	it("域名解析到 IPv6 私网被拒绝", async () => {
		const r = await checkUrl("http://evil.com/", {
			lookup: mockLookup({ "evil.com": ["fd00::1"] }),
		});
		expect(r.ok).toBe(false);
	});
	it("解析失败返回失败而非放行", async () => {
		const r = await checkUrl("http://nonexistent.invalid/", { lookup: mockLookup({}) });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toContain("DNS");
	});
	it("公网域名放行并返回地址列表", async () => {
		const r = await checkUrl("https://example.com/", {
			lookup: mockLookup({ "example.com": ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"] }),
		});
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.addresses).toHaveLength(2);
			expect(r.port).toBe(443);
		}
	});
});

describe("isDeniedIp 统一入口", () => {
	it("按地址形式分流", () => {
		expect(isDeniedIp("127.0.0.1")).toBe(true);
		expect(isDeniedIp("::1")).toBe(true);
		expect(isDeniedIp("8.8.8.8")).toBe(false);
		expect(isDeniedIp("2001:db8::1")).toBe(false);
	});
});
