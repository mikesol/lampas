import { z } from "zod";

/**
 * Possible states of a Lampas job throughout its lifecycle.
 *
 * - `queued` — job accepted, awaiting execution
 * - `in_progress` — upstream call in flight
 * - `completed` — upstream response delivered to all callbacks
 * - `failed` — all retry attempts exhausted
 */
export const JobStatus = {
	queued: "queued",
	in_progress: "in_progress",
	completed: "completed",
	failed: "failed",
} as const;

/** Union of all valid job status values. */
export type JobStatus = (typeof JobStatus)[keyof typeof JobStatus];

/** Zod schema for {@link JobStatus}. */
export const JobStatusSchema = z.enum(["queued", "in_progress", "completed", "failed"]);

/**
 * A callback destination for upstream response delivery.
 *
 * Each callback has a URL and optional headers (useful for correlation IDs).
 */
export interface Callback {
	/** The URL to deliver the upstream response to. */
	url: string;
	/** Optional headers sent with the callback delivery (e.g. correlation IDs). */
	headers?: Record<string, string>;
}

/** Zod schema for {@link Callback}. */
export const CallbackSchema = z.object({
	url: z.string().url("Callback URL must be a valid URL"),
	headers: z.record(z.string(), z.string()).optional(),
});

/**
 * Retry policy for callback delivery.
 *
 * Controls how many times Lampas retries failed deliveries and the backoff strategy.
 */
export interface RetryPolicy {
	/** Number of delivery attempts (including the initial attempt). Defaults to 3. */
	attempts: number;
	/** Backoff strategy. Only "exponential" is supported in Phase 0. */
	backoff: "exponential";
	/** Initial delay in milliseconds before the first retry. Defaults to 1000. */
	initial_delay_ms: number;
}

/** Zod schema for {@link RetryPolicy}. */
export const RetryPolicySchema = z.object({
	attempts: z.number().int().min(1, "Retry attempts must be at least 1").default(3),
	backoff: z.literal("exponential").default("exponential"),
	initial_delay_ms: z.number().int().min(0, "Initial delay must be non-negative").default(1000),
});

/**
 * The request body sent to Lampas to create a new job.
 *
 * Contains the complete execution specification: what to call, where to deliver
 * the response, how to retry, and what credentials to forward.
 */
export interface RequestBody {
	/** The upstream API URL to call. */
	target: string;
	/** Headers to forward to the target (e.g. Authorization). */
	forward_headers: Record<string, string>;
	/** One or more callback destinations for the upstream response. */
	callbacks: Callback[];
	/** Retry policy for callback delivery. Uses defaults if omitted. */
	retry?: RetryPolicy;
	/** Arbitrary payload passed through verbatim to the target. */
	body: unknown;
}

/** Zod schema for {@link RequestBody} with runtime validation. */
export const RequestBodySchema = z.object({
	target: z.string().url("Target must be a valid URL"),
	forward_headers: z.record(z.string(), z.string()),
	callbacks: z.array(CallbackSchema).min(1, "At least one callback is required"),
	retry: RetryPolicySchema.optional(),
	body: z.unknown(),
});

/**
 * A Lampas job — the unit of work.
 *
 * Created when a request arrives. Tracks status, timestamps, and the
 * original request for auditability.
 */
export interface Job {
	/** Unique identifier for this job. */
	id: string;
	/** Current status of the job. */
	status: JobStatus;
	/** ISO 8601 timestamp of job creation. */
	created_at: string;
	/** ISO 8601 timestamp of the last status change. */
	updated_at: string;
	/** The original request that created this job. */
	request: RequestBody;
}

/** Zod schema for {@link Job}. */
export const JobSchema = z.object({
	id: z.string(),
	status: JobStatusSchema,
	created_at: z.string().datetime(),
	updated_at: z.string().datetime(),
	request: RequestBodySchema,
});
