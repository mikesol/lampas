import { z } from "zod";

/**
 * Possible states of a Lampas job throughout its lifecycle.
 *
 * - `queued` — job accepted, awaiting execution
 * - `in_progress` — upstream call in flight
 * - `completed` — upstream response delivered to all callbacks
 * - `failed` — all retry attempts exhausted
 */
export const JobStatusSchema = z.enum(["queued", "in_progress", "completed", "failed"]);

/** Union of all valid job status values. */
export type JobStatus = z.infer<typeof JobStatusSchema>;

/**
 * Zod schema for a callback destination.
 *
 * Each callback has a URL and optional headers (useful for correlation IDs).
 */
export const CallbackSchema = z.object({
	url: z.string().url("Callback URL must be a valid URL"),
	headers: z.record(z.string(), z.string()).optional(),
});

/** A callback destination for upstream response delivery. */
export type Callback = z.infer<typeof CallbackSchema>;

/**
 * Zod schema for retry policy.
 *
 * Controls how many times Lampas retries failed deliveries and the backoff strategy.
 * Fields have defaults: attempts=3, backoff="exponential", initial_delay_ms=1000, max_delay_ms=30000.
 */
export const RetryPolicySchema = z.object({
	attempts: z.number().int().min(1, "Retry attempts must be at least 1").default(3),
	backoff: z.literal("exponential").default("exponential"),
	initial_delay_ms: z.number().int().min(0, "Initial delay must be non-negative").default(1000),
	max_delay_ms: z.number().int().min(1, "Max delay must be at least 1ms").default(30000),
});

/** Retry policy after Zod defaults have been applied. */
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

/** Retry policy as accepted in input (all fields optional due to defaults). */
export type RetryPolicyInput = z.input<typeof RetryPolicySchema>;

/**
 * Zod schema for the Lampas request body.
 *
 * Contains the complete execution specification: what to call, where to deliver
 * the response, how to retry, and what credentials to forward.
 */
export const RequestBodySchema = z.object({
	target: z.string().url("Target must be a valid URL"),
	forward_headers: z.record(z.string(), z.string()),
	callbacks: z.array(CallbackSchema).min(1, "At least one callback is required"),
	retry: RetryPolicySchema.optional(),
	body: z.unknown(),
});

/** The parsed request body after validation and defaults. */
export type RequestBody = z.infer<typeof RequestBodySchema>;

/** The request body as accepted in input (retry optional, fields have defaults). */
export type RequestBodyInput = z.input<typeof RequestBodySchema>;

/**
 * Zod schema for a Lampas job — the unit of work.
 *
 * Created when a request arrives. Tracks status, timestamps, and the
 * original request for auditability.
 */
export const JobSchema = z.object({
	id: z.string(),
	status: JobStatusSchema,
	created_at: z.string().datetime(),
	updated_at: z.string().datetime(),
	request: RequestBodySchema,
});

/** A Lampas job — the unit of work. */
export type Job = z.infer<typeof JobSchema>;
