import {
	type Callback,
	type Envelope,
	type Job,
	type JobStatus,
	type RetryPolicy,
	RetryPolicySchema,
	type UpstreamResponse,
	buildEnvelope,
	computeBackoff,
	shouldRetry,
} from "@lampas/core";
import { serializeBody } from "./http.js";

/** Per-callback delivery tracking state. */
export interface CallbackState {
	status: "pending" | "delivered" | "failed";
	attempts: number;
	next_retry_at: number | null;
}

const DEFAULT_RETRY_POLICY: RetryPolicy = RetryPolicySchema.parse({});

/** Execute the upstream request and deliver the envelope to all callbacks. */
export async function executeAndDeliver(storage: DurableObjectStorage, job: Job): Promise<void> {
	await updateStatus(storage, "in_progress");

	const forwardHeaders = await storage.get<Record<string, string>>("forward_headers");

	let upstream: UpstreamResponse;
	try {
		const method = job.request.method ?? "POST";
		const hasBody = method !== "GET" && method !== "HEAD";
		const controller = new AbortController();
		const timeoutMs = job.request.timeout_ms ?? 30000;
		const timer = setTimeout(() => controller.abort(), timeoutMs);

		const response = await fetch(job.request.target, {
			method,
			headers: forwardHeaders ?? {},
			body: hasBody ? serializeBody(job.request.body) : null,
			signal: controller.signal,
		});

		clearTimeout(timer);

		const headers: Record<string, string> = {};
		response.headers.forEach((v, k) => {
			headers[k] = v;
		});

		let body: unknown;
		const text = await response.text();
		try {
			body = JSON.parse(text);
		} catch {
			body = text;
		}

		upstream = { status: response.status, headers, body };
	} catch {
		upstream = { status: 0, headers: {}, body: null };
	}

	await storage.put("upstream_response", upstream);
	await storage.delete("forward_headers");

	const envelope = buildEnvelope(job.id, job.request.target, upstream, new Date().toISOString());
	await deliverAllCallbacks(storage, job, envelope);
}

/** Retry any pending callbacks triggered by an alarm. */
export async function retryPendingCallbacks(
	storage: DurableObjectStorage,
	job: Job,
): Promise<void> {
	const upstreamResponse = await storage.get<UpstreamResponse>("upstream_response");
	if (!upstreamResponse) return;

	const retryPolicy = getRetryPolicy(job);
	const envelope = buildEnvelope(
		job.id,
		job.request.target,
		upstreamResponse,
		new Date().toISOString(),
	);

	const now = Date.now();
	let earliestRetry: number | null = null;

	for (let i = 0; i < job.request.callbacks.length; i++) {
		const state = await storage.get<CallbackState>(`cb:${i}`);
		if (!state || state.status !== "pending") continue;

		if (state.next_retry_at && state.next_retry_at > now) {
			if (earliestRetry === null || state.next_retry_at < earliestRetry) {
				earliestRetry = state.next_retry_at;
			}
			continue;
		}

		const success = await deliverOne(job.request.callbacks[i], envelope);
		const newAttempts = state.attempts + 1;

		if (success) {
			await storage.put(`cb:${i}`, {
				status: "delivered",
				attempts: newAttempts,
				next_retry_at: null,
			} satisfies CallbackState);
		} else if (shouldRetry(newAttempts, retryPolicy)) {
			const delay = computeBackoff(state.attempts, retryPolicy);
			const nextRetry = now + delay;
			await storage.put(`cb:${i}`, {
				status: "pending",
				attempts: newAttempts,
				next_retry_at: nextRetry,
			} satisfies CallbackState);
			if (earliestRetry === null || nextRetry < earliestRetry) earliestRetry = nextRetry;
		} else {
			await storage.put(`cb:${i}`, {
				status: "failed",
				attempts: newAttempts,
				next_retry_at: null,
			} satisfies CallbackState);
		}
	}

	await resolveJobStatus(storage, job);
	if (earliestRetry !== null) {
		await storage.setAlarm(earliestRetry);
	}
}

async function deliverAllCallbacks(
	storage: DurableObjectStorage,
	job: Job,
	envelope: Envelope,
): Promise<void> {
	const retryPolicy = getRetryPolicy(job);

	const results = await Promise.all(job.request.callbacks.map((cb) => deliverOne(cb, envelope)));

	const now = Date.now();
	let earliestRetry: number | null = null;

	for (let i = 0; i < results.length; i++) {
		let state: CallbackState;
		if (results[i]) {
			state = { status: "delivered", attempts: 1, next_retry_at: null };
		} else if (shouldRetry(1, retryPolicy)) {
			const delay = computeBackoff(0, retryPolicy);
			const nextRetry = now + delay;
			state = { status: "pending", attempts: 1, next_retry_at: nextRetry };
			if (earliestRetry === null || nextRetry < earliestRetry) earliestRetry = nextRetry;
		} else {
			state = { status: "failed", attempts: 1, next_retry_at: null };
		}
		await storage.put(`cb:${i}`, state);
	}

	await resolveJobStatus(storage, job);
	if (earliestRetry !== null) {
		await storage.setAlarm(earliestRetry);
	}
}

async function deliverOne(callback: Callback, envelope: Envelope): Promise<boolean> {
	try {
		const response = await fetch(callback.url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(callback.headers ?? {}),
			},
			body: JSON.stringify(envelope),
		});
		return response.status >= 200 && response.status < 300;
	} catch {
		return false;
	}
}

async function resolveJobStatus(storage: DurableObjectStorage, job: Job): Promise<void> {
	const states: CallbackState[] = [];
	for (let i = 0; i < job.request.callbacks.length; i++) {
		const state = await storage.get<CallbackState>(`cb:${i}`);
		if (state) states.push(state);
	}
	if (states.length === 0) return;

	if (states.every((s) => s.status === "delivered")) {
		await updateStatus(storage, "completed");
	} else if (
		states.some((s) => s.status === "failed") &&
		!states.some((s) => s.status === "pending")
	) {
		await updateStatus(storage, "failed");
	}
}

async function updateStatus(storage: DurableObjectStorage, status: JobStatus): Promise<void> {
	const job = await storage.get<Job>("job");
	if (!job) return;
	job.status = status;
	job.updated_at = new Date().toISOString();
	await storage.put("job", job);
}

function getRetryPolicy(job: Job): RetryPolicy {
	return job.request.retry ?? DEFAULT_RETRY_POLICY;
}
