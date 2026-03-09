import { describe, expect, it } from "vitest";
import {
	BLOCKED_CIDRS,
	type SsrfPolicy,
	ipInCidr,
	parseCidr,
	parseIp,
	parseIpv4,
	parseIpv6,
	parseSsrfPolicy,
	validateIp,
	validateUrl,
} from "./ssrf";

const POLICY_ON: SsrfPolicy = { blockPrivate: true, allowlist: [] };
const POLICY_OFF: SsrfPolicy = { blockPrivate: false, allowlist: [] };

/** Parse an IP, throwing if invalid (avoids non-null assertions in tests). */
function ip(addr: string): Uint8Array {
	const result = parseIp(addr);
	if (!result) throw new Error(`Test setup error: invalid IP ${addr}`);
	return result;
}

describe("parseIpv4", () => {
	it("parses valid addresses", () => {
		expect(parseIpv4("0.0.0.0")).toEqual(new Uint8Array([0, 0, 0, 0]));
		expect(parseIpv4("192.168.1.1")).toEqual(new Uint8Array([192, 168, 1, 1]));
		expect(parseIpv4("255.255.255.255")).toEqual(new Uint8Array([255, 255, 255, 255]));
	});

	it("rejects invalid addresses", () => {
		expect(parseIpv4("")).toBeNull();
		expect(parseIpv4("1.2.3")).toBeNull();
		expect(parseIpv4("1.2.3.4.5")).toBeNull();
		expect(parseIpv4("256.0.0.0")).toBeNull();
		expect(parseIpv4("1.2.3.04")).toBeNull();
		expect(parseIpv4("abc.def.ghi.jkl")).toBeNull();
	});
});

describe("parseIpv6", () => {
	it("parses full addresses", () => {
		const result = parseIpv6("2001:0db8:0000:0000:0000:0000:0000:0001");
		expect(result).not.toBeNull();
		expect(result?.[0]).toBe(0x20);
		expect(result?.[1]).toBe(0x01);
	});

	it("parses compressed addresses", () => {
		expect(parseIpv6("::1")).not.toBeNull();
		expect(parseIpv6("::")).not.toBeNull();
		expect(parseIpv6("fe80::1")).not.toBeNull();
	});

	it("parses v4-mapped addresses", () => {
		const result = parseIpv6("::ffff:192.168.1.1");
		expect(result).not.toBeNull();
		expect(result?.[12]).toBe(192);
		expect(result?.[13]).toBe(168);
		expect(result?.[14]).toBe(1);
		expect(result?.[15]).toBe(1);
	});

	it("rejects invalid addresses", () => {
		expect(parseIpv6("")).toBeNull();
		expect(parseIpv6(":::1")).toBeNull();
		expect(parseIpv6("1:2:3:4:5:6:7:8:9")).toBeNull();
		expect(parseIpv6("gggg::1")).toBeNull();
	});
});

describe("parseIp", () => {
	it("detects v4 and v6", () => {
		expect(parseIp("10.0.0.1")?.length).toBe(4);
		expect(parseIp("::1")?.length).toBe(16);
		expect(parseIp("not-an-ip")).toBeNull();
	});
});

describe("parseCidr", () => {
	it("parses valid CIDR", () => {
		const range = parseCidr("10.0.0.0/8");
		expect(range.bytes).toEqual(new Uint8Array([10, 0, 0, 0]));
		expect(range.prefixLength).toBe(8);
	});

	it("throws on invalid CIDR", () => {
		expect(() => parseCidr("10.0.0.0")).toThrow("missing prefix");
		expect(() => parseCidr("bad/8")).toThrow("Invalid IP");
		expect(() => parseCidr("10.0.0.0/33")).toThrow("Invalid prefix");
	});
});

describe("ipInCidr", () => {
	it("matches IPs in range", () => {
		const cidr = parseCidr("10.0.0.0/8");
		expect(ipInCidr(ip("10.0.0.1"), cidr)).toBe(true);
		expect(ipInCidr(ip("10.255.255.255"), cidr)).toBe(true);
		expect(ipInCidr(ip("11.0.0.0"), cidr)).toBe(false);
	});

	it("handles /16 prefix", () => {
		const cidr = parseCidr("192.168.0.0/16");
		expect(ipInCidr(ip("192.168.1.1"), cidr)).toBe(true);
		expect(ipInCidr(ip("192.169.0.0"), cidr)).toBe(false);
	});

	it("handles /12 prefix with partial byte", () => {
		const cidr = parseCidr("172.16.0.0/12");
		expect(ipInCidr(ip("172.16.0.1"), cidr)).toBe(true);
		expect(ipInCidr(ip("172.31.255.255"), cidr)).toBe(true);
		expect(ipInCidr(ip("172.32.0.0"), cidr)).toBe(false);
	});

	it("handles IPv6 ranges", () => {
		const cidr = parseCidr("fc00::/7");
		expect(ipInCidr(ip("fc00::1"), cidr)).toBe(true);
		expect(ipInCidr(ip("fdff::1"), cidr)).toBe(true);
		expect(ipInCidr(ip("fe00::1"), cidr)).toBe(false);
	});

	it("handles loopback ::1/128", () => {
		const cidr = parseCidr("::1/128");
		expect(ipInCidr(ip("::1"), cidr)).toBe(true);
		expect(ipInCidr(ip("::2"), cidr)).toBe(false);
	});
});

describe("validateUrl", () => {
	it("allows public HTTP(S) URLs", () => {
		expect(validateUrl("https://api.example.com/data", POLICY_ON).ok).toBe(true);
		expect(validateUrl("http://webhook.site/abc", POLICY_ON).ok).toBe(true);
	});

	it("blocks non-HTTP schemes", () => {
		const r1 = validateUrl("file:///etc/passwd", POLICY_ON);
		expect(r1.ok).toBe(false);
		if (!r1.ok) expect(r1.reason).toContain("Blocked scheme");

		const r2 = validateUrl("ftp://internal/file", POLICY_ON);
		expect(r2.ok).toBe(false);
	});

	it("blocks private IPv4 addresses in URL", () => {
		expect(validateUrl("http://127.0.0.1/path", POLICY_ON).ok).toBe(false);
		expect(validateUrl("http://10.0.0.1/path", POLICY_ON).ok).toBe(false);
		expect(validateUrl("http://192.168.1.1/path", POLICY_ON).ok).toBe(false);
		expect(validateUrl("http://172.16.0.1/path", POLICY_ON).ok).toBe(false);
		expect(validateUrl("http://169.254.169.254/metadata", POLICY_ON).ok).toBe(false);
		expect(validateUrl("http://0.0.0.1/path", POLICY_ON).ok).toBe(false);
	});

	it("blocks private IPv6 addresses in URL", () => {
		expect(validateUrl("http://[::1]/path", POLICY_ON).ok).toBe(false);
		expect(validateUrl("http://[fc00::1]/path", POLICY_ON).ok).toBe(false);
		expect(validateUrl("http://[fe80::1]/path", POLICY_ON).ok).toBe(false);
	});

	it("allows public IPs", () => {
		expect(validateUrl("http://93.184.216.34/path", POLICY_ON).ok).toBe(true);
		expect(validateUrl("http://8.8.8.8/dns", POLICY_ON).ok).toBe(true);
	});

	it("skips validation when policy is off", () => {
		expect(validateUrl("http://127.0.0.1/path", POLICY_OFF).ok).toBe(true);
		expect(validateUrl("file:///etc/passwd", POLICY_OFF).ok).toBe(true);
	});

	it("allows domain hostnames (DNS not resolved here)", () => {
		expect(validateUrl("https://evil.attacker.com/path", POLICY_ON).ok).toBe(true);
	});
});

describe("validateIp", () => {
	it("blocks private IPs", () => {
		expect(validateIp("127.0.0.1", POLICY_ON).ok).toBe(false);
		expect(validateIp("10.0.0.1", POLICY_ON).ok).toBe(false);
		expect(validateIp("::1", POLICY_ON).ok).toBe(false);
	});

	it("allows public IPs", () => {
		expect(validateIp("93.184.216.34", POLICY_ON).ok).toBe(true);
		expect(validateIp("2606:2800:220:1:248:1893:25c8:1946", POLICY_ON).ok).toBe(true);
	});

	it("rejects invalid IP strings", () => {
		const result = validateIp("not-an-ip", POLICY_ON);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("Invalid IP");
	});
});

describe("parseSsrfPolicy", () => {
	it("defaults to blocking enabled, empty allowlist", () => {
		const policy = parseSsrfPolicy();
		expect(policy.blockPrivate).toBe(true);
		expect(policy.allowlist).toEqual([]);
	});

	it("respects SSRF_BLOCK_PRIVATE=false", () => {
		expect(parseSsrfPolicy("false").blockPrivate).toBe(false);
	});

	it("treats any non-false value as true", () => {
		expect(parseSsrfPolicy("true").blockPrivate).toBe(true);
		expect(parseSsrfPolicy("yes").blockPrivate).toBe(true);
		expect(parseSsrfPolicy("").blockPrivate).toBe(true);
	});

	it("parses comma-separated CIDR allowlist", () => {
		const policy = parseSsrfPolicy("true", "10.0.0.0/8, 172.16.0.0/12");
		expect(policy.allowlist).toHaveLength(2);
	});

	it("ignores empty entries in allowlist", () => {
		const policy = parseSsrfPolicy("true", "10.0.0.0/8,,");
		expect(policy.allowlist).toHaveLength(1);
	});
});

describe("allowlist overrides", () => {
	it("allows private IPs that are in the allowlist", () => {
		const policy: SsrfPolicy = {
			blockPrivate: true,
			allowlist: [parseCidr("10.0.0.0/8")],
		};
		expect(validateIp("10.0.0.1", policy).ok).toBe(true);
		expect(validateUrl("http://10.0.0.1/path", policy).ok).toBe(true);
	});

	it("still blocks other private ranges not in allowlist", () => {
		const policy: SsrfPolicy = {
			blockPrivate: true,
			allowlist: [parseCidr("10.0.0.0/8")],
		};
		expect(validateIp("192.168.1.1", policy).ok).toBe(false);
		expect(validateIp("127.0.0.1", policy).ok).toBe(false);
	});
});

describe("all blocked CIDRs are parseable", () => {
	it("parses every default range", () => {
		for (const cidr of BLOCKED_CIDRS) {
			expect(() => parseCidr(cidr)).not.toThrow();
		}
	});
});
