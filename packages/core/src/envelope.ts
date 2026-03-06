import { z } from "zod";

/**
 * Zod schema for the Lampas envelope — the wrapper around upstream responses
 * delivered to callbacks.
 *
 * Contains the job ID, delivery metadata, and the upstream response preserved
 * verbatim (status, headers, body).
 */
export const EnvelopeSchema = z.object({
	lampas_job_id: z.string(),
	lampas_status: z.enum(["completed", "failed"]),
	lampas_target: z.string().url(),
	lampas_delivered_at: z.string().datetime(),
	response_status: z.number().int(),
	response_headers: z.record(z.string(), z.string()),
	response_body: z.unknown(),
});

/** The envelope Lampas wraps around upstream responses when delivering to callbacks. */
export type Envelope = z.infer<typeof EnvelopeSchema>;

/** Sorted keys for deterministic serialization. */
const KEY_ORDER: readonly (keyof Envelope)[] = [
	"lampas_job_id",
	"lampas_status",
	"lampas_target",
	"lampas_delivered_at",
	"response_status",
	"response_headers",
	"response_body",
];

/**
 * Upstream HTTP response data used to build an envelope.
 *
 * Represents the raw response from the target API: status code, headers, and body.
 */
export interface UpstreamResponse {
	status: number;
	headers: Record<string, string>;
	body: unknown;
}

/**
 * Constructs a deterministic {@link Envelope} from a job ID, target URL, and upstream response.
 *
 * The upstream response body is preserved verbatim — Lampas never parses or transforms it.
 * Key ordering is stable for testability.
 *
 * @param jobId - The Lampas job ID
 * @param target - The original target URL
 * @param upstream - The upstream HTTP response
 * @param deliveredAt - ISO 8601 delivery timestamp
 * @returns A fully constructed Envelope with deterministic key order
 */
export function buildEnvelope(
	jobId: string,
	target: string,
	upstream: UpstreamResponse,
	deliveredAt: string,
): Envelope {
	const envelope: Envelope = {
		lampas_job_id: jobId,
		lampas_status: upstream.status >= 200 && upstream.status < 300 ? "completed" : "failed",
		lampas_target: target,
		lampas_delivered_at: deliveredAt,
		response_status: upstream.status,
		response_headers: upstream.headers,
		response_body: upstream.body,
	};

	// Rebuild with stable key order for deterministic serialization
	const ordered: Record<string, unknown> = {};
	for (const key of KEY_ORDER) {
		ordered[key] = envelope[key];
	}
	return ordered as Envelope;
}
