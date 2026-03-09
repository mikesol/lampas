import {
	type Callback,
	type SsrfPolicy,
	type SsrfResult,
	parseIp,
	validateIp,
	validateUrl,
} from "@lampas/core";

interface DnsJsonResponse {
	Answer?: { type: number; data: string }[];
}

/** DNS record types: A=1, AAAA=28. */
const DNS_RECORD_TYPES = [1, 28] as const;

/** Resolve a hostname to IP addresses via Cloudflare DNS-over-HTTPS. */
export async function resolveHostname(hostname: string): Promise<string[]> {
	const queries = ["A", "AAAA"].map(async (type) => {
		const params = new URLSearchParams({ name: hostname, type });
		const resp = await fetch(`https://cloudflare-dns.com/dns-query?${params}`, {
			headers: { Accept: "application/dns-json" },
		});
		return (await resp.json()) as DnsJsonResponse;
	});

	const [aData, aaaaData] = await Promise.all(queries);
	const ips: string[] = [];
	for (const answer of [...(aData.Answer ?? []), ...(aaaaData.Answer ?? [])]) {
		if (DNS_RECORD_TYPES.includes(answer.type as 1 | 28)) {
			ips.push(answer.data);
		}
	}
	return ips;
}

/**
 * Validate a single URL against SSRF policy, including DNS resolution.
 *
 * Fails open on DNS resolution errors — CF Workers provide additional
 * protection at the fetch layer.
 */
async function validateUrlWithDns(
	url: string,
	policy: SsrfPolicy,
	resolver: (hostname: string) => Promise<string[]>,
): Promise<SsrfResult> {
	const urlCheck = validateUrl(url, policy);
	if (!urlCheck.ok) return urlCheck;
	if (!policy.blockPrivate) return { ok: true };

	const parsed = new URL(url);
	const hostname =
		parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]")
			? parsed.hostname.slice(1, -1)
			: parsed.hostname;

	if (parseIp(hostname)) return { ok: true };

	let ips: string[];
	try {
		ips = await resolver(hostname);
	} catch {
		return { ok: true };
	}

	for (const ip of ips) {
		const result = validateIp(ip, policy);
		if (!result.ok) {
			return { ok: false, reason: `${hostname} resolves to blocked IP: ${ip}` };
		}
	}
	return { ok: true };
}

/**
 * Validate all URLs in a request (target + callbacks) against the SSRF policy.
 *
 * Returns the first failure or `{ ok: true }` if all pass.
 */
export async function validateRequestSsrf(
	target: string,
	callbacks: Callback[],
	policy: SsrfPolicy,
	resolver: (hostname: string) => Promise<string[]> = resolveHostname,
): Promise<SsrfResult> {
	if (!policy.blockPrivate) return { ok: true };

	const urls = [target, ...callbacks.map((cb) => cb.url)];
	const results = await Promise.all(urls.map((url) => validateUrlWithDns(url, policy, resolver)));

	for (const result of results) {
		if (!result.ok) return result;
	}
	return { ok: true };
}
