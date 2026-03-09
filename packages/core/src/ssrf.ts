/** A parsed CIDR range for IP matching. */
export interface CidrRange {
	readonly bytes: Uint8Array;
	readonly prefixLength: number;
}

/** SSRF protection policy configuration. */
export interface SsrfPolicy {
	readonly blockPrivate: boolean;
	readonly allowlist: readonly CidrRange[];
}

/** Result of SSRF validation. */
export type SsrfResult = { ok: true } | { ok: false; reason: string };

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/** Default private/reserved CIDR ranges blocked by SSRF policy. */
export const BLOCKED_CIDRS: readonly string[] = [
	"0.0.0.0/8",
	"10.0.0.0/8",
	"127.0.0.0/8",
	"169.254.0.0/16",
	"172.16.0.0/12",
	"192.168.0.0/16",
	"::1/128",
	"fc00::/7",
	"fe80::/10",
];

/** Parse an IPv4 address string to 4 bytes. Returns null if invalid. */
export function parseIpv4(ip: string): Uint8Array | null {
	const parts = ip.split(".");
	if (parts.length !== 4) return null;
	const bytes = new Uint8Array(4);
	for (let i = 0; i < 4; i++) {
		const n = Number(parts[i]);
		if (!Number.isInteger(n) || n < 0 || n > 255 || parts[i] !== String(n)) return null;
		bytes[i] = n;
	}
	return bytes;
}

/** Parse an IPv6 address string to 16 bytes. Returns null if invalid. */
export function parseIpv6(ip: string): Uint8Array | null {
	const v4Mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
	if (v4Mapped) {
		const v4 = parseIpv4(v4Mapped[1]);
		if (!v4) return null;
		const bytes = new Uint8Array(16);
		bytes[10] = 0xff;
		bytes[11] = 0xff;
		bytes.set(v4, 12);
		return bytes;
	}

	const halves = ip.split("::");
	if (halves.length > 2) return null;

	const left = halves[0] ? halves[0].split(":") : [];
	const right = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : [];

	if (halves.length === 1 && left.length !== 8) return null;
	if (left.length + right.length > 8) return null;

	const groups: number[] = [];
	for (const g of left) {
		if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
		groups.push(Number.parseInt(g, 16));
	}
	const missing = 8 - left.length - right.length;
	for (let i = 0; i < missing; i++) groups.push(0);
	for (const g of right) {
		if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
		groups.push(Number.parseInt(g, 16));
	}

	if (groups.length !== 8) return null;
	const bytes = new Uint8Array(16);
	for (let i = 0; i < 8; i++) {
		bytes[i * 2] = (groups[i] >> 8) & 0xff;
		bytes[i * 2 + 1] = groups[i] & 0xff;
	}
	return bytes;
}

/** Parse an IP address (v4 or v6) to bytes. Returns null if not a valid IP. */
export function parseIp(ip: string): Uint8Array | null {
	return parseIpv4(ip) ?? parseIpv6(ip);
}

/** Parse a CIDR notation string into a CidrRange. Throws on invalid input. */
export function parseCidr(cidr: string): CidrRange {
	const slash = cidr.lastIndexOf("/");
	if (slash === -1) throw new Error(`Invalid CIDR (missing prefix): ${cidr}`);
	const ipStr = cidr.slice(0, slash);
	const bytes = parseIp(ipStr);
	if (!bytes) throw new Error(`Invalid IP in CIDR: ${cidr}`);
	const prefixLength = Number(cidr.slice(slash + 1));
	const maxPrefix = bytes.length === 4 ? 32 : 128;
	if (!Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > maxPrefix) {
		throw new Error(`Invalid prefix length in CIDR: ${cidr}`);
	}
	return { bytes, prefixLength };
}

/** Check if an IP (as bytes) falls within a CIDR range. */
export function ipInCidr(ip: Uint8Array, cidr: CidrRange): boolean {
	let ipBytes = ip;
	let cidrBytes = cidr.bytes;
	let { prefixLength } = cidr;

	if (ipBytes.length !== cidrBytes.length) {
		if (ipBytes.length === 4 && cidrBytes.length === 16) {
			const expanded = new Uint8Array(16);
			expanded[10] = 0xff;
			expanded[11] = 0xff;
			expanded.set(ipBytes, 12);
			ipBytes = expanded;
		} else if (ipBytes.length === 16 && cidrBytes.length === 4) {
			const expanded = new Uint8Array(16);
			expanded[10] = 0xff;
			expanded[11] = 0xff;
			expanded.set(cidrBytes, 12);
			cidrBytes = expanded;
			prefixLength += 96;
		} else {
			return false;
		}
	}

	const fullBytes = Math.floor(prefixLength / 8);
	for (let i = 0; i < fullBytes; i++) {
		if (ipBytes[i] !== cidrBytes[i]) return false;
	}
	const remainingBits = prefixLength % 8;
	if (remainingBits > 0) {
		const mask = 0xff << (8 - remainingBits);
		if ((ipBytes[fullBytes] & mask) !== (cidrBytes[fullBytes] & mask)) return false;
	}
	return true;
}

let _blockedRanges: CidrRange[] | null = null;
function getBlockedRanges(): CidrRange[] {
	if (!_blockedRanges) _blockedRanges = BLOCKED_CIDRS.map(parseCidr);
	return _blockedRanges;
}

function validateIpBytes(bytes: Uint8Array, policy: SsrfPolicy): SsrfResult {
	if (policy.allowlist.some((cidr) => ipInCidr(bytes, cidr))) return { ok: true };
	if (getBlockedRanges().some((cidr) => ipInCidr(bytes, cidr))) {
		return { ok: false, reason: "IP address is in a blocked private/reserved range" };
	}
	return { ok: true };
}

/**
 * Extract the scheme from a URL string.
 * Returns the scheme including the colon (e.g. "https:"), or null if unparseable.
 */
function extractScheme(url: string): string | null {
	const match = url.match(/^([a-zA-Z][a-zA-Z0-9+\-.]*:)/);
	return match ? match[1].toLowerCase() : null;
}

/**
 * Extract the hostname from a URL string.
 * Handles `scheme://[ipv6]:port/path` and `scheme://host:port/path`.
 */
function extractHostname(url: string): string | null {
	const authorityStart = url.indexOf("://");
	if (authorityStart === -1) return null;
	const rest = url.slice(authorityStart + 3);

	if (rest.startsWith("[")) {
		const bracketEnd = rest.indexOf("]");
		if (bracketEnd === -1) return null;
		return rest.slice(1, bracketEnd);
	}

	const hostEnd = rest.search(/[:/]/);
	return hostEnd === -1 ? rest : rest.slice(0, hostEnd);
}

/** Validate a URL for SSRF safety (scheme and raw-IP hostname check). Does not resolve DNS. */
export function validateUrl(url: string, policy: SsrfPolicy): SsrfResult {
	if (!policy.blockPrivate) return { ok: true };

	const scheme = extractScheme(url);
	if (!scheme) return { ok: false, reason: "Invalid URL" };
	if (!ALLOWED_SCHEMES.has(scheme)) {
		return { ok: false, reason: `Blocked scheme: ${scheme}` };
	}

	const hostname = extractHostname(url);
	if (!hostname) return { ok: false, reason: "Invalid URL" };

	const bytes = parseIp(hostname);
	if (!bytes) return { ok: true };
	return validateIpBytes(bytes, policy);
}

/** Validate a resolved IP address string against the SSRF policy. */
export function validateIp(ip: string, policy: SsrfPolicy): SsrfResult {
	if (!policy.blockPrivate) return { ok: true };
	const bytes = parseIp(ip);
	if (!bytes) return { ok: false, reason: `Invalid IP address: ${ip}` };
	return validateIpBytes(bytes, policy);
}

/** Parse SSRF policy from environment variable strings. */
export function parseSsrfPolicy(blockPrivate?: string, allowlistCsv?: string): SsrfPolicy {
	const block = blockPrivate !== "false";
	const allowlist: CidrRange[] = [];
	if (allowlistCsv) {
		for (const cidr of allowlistCsv.split(",")) {
			const trimmed = cidr.trim();
			if (trimmed) allowlist.push(parseCidr(trimmed));
		}
	}
	return { blockPrivate: block, allowlist };
}
