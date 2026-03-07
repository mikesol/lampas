import {
	type Callback,
	type Envelope,
	type Job,
	type JobStatus,
	RequestBodySchema,
	type RetryPolicy,
	RetryPolicySchema,
	type UpstreamResponse,
	buildEnvelope,
	computeBackoff,
	shouldRetry,
} from "@lampas/core";

/** Per-callback delivery tracking state. */
export interface CallbackState {
	status: "pending" | "delivered" | "failed";
	attempts: number;
	next_retry_at: number | null;
}

/** Cloudflare Worker environment bindings. */
export interface Env {
	JOB_DO: DurableObjectNamespace;
}

const DEFAULT_RETRY_POLICY: RetryPolicy = RetryPolicySchema.parse({});

function serializeBody(body: unknown): BodyInit | null {
	if (body === null || body === undefined) return null;
	if (typeof body === "string") return body;
	return JSON.stringify(body);
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

/** Durable Object that owns the full lifecycle of a Lampas job. */
export class JobDO implements DurableObject {
	constructor(
		private readonly ctx: DurableObjectState,
		private readonly env: Env,
	) {}

	async fetch(request: Request): Promise<Response> {
		if (request.method === "POST") {
			return this.handleCreate(request);
		}
		if (request.method === "GET") {
			return this.handleStatus();
		}
		return jsonResponse(405, { error: "Method not allowed" });
	}

	async alarm(): Promise<void> {
		const job = await this.ctx.storage.get<Job>("job");
		if (!job) return;

		if (job.status === "queued") {
			await this.executeAndDeliver(job);
		} else if (job.status === "in_progress") {
			await this.retryPendingCallbacks(job);
		}
	}

	private async handleCreate(request: Request): Promise<Response> {
		let rawBody: unknown;
		try {
			rawBody = await request.json();
		} catch {
			return jsonResponse(400, { error: "Request body must be valid JSON" });
		}

		const jobId = request.headers.get("X-Lampas-Job-Id");
		if (!jobId) {
			return jsonResponse(400, { error: "Missing job ID" });
		}

		const result = RequestBodySchema.safeParse(rawBody);
		if (!result.success) {
			const messages = result.error.issues.map((i) => i.message);
			return jsonResponse(400, { error: messages.join("; ") });
		}

		const now = new Date().toISOString();
		const job: Job = {
			id: jobId,
			status: "queued",
			created_at: now,
			updated_at: now,
			request: { ...result.data, forward_headers: {} },
		};

		await this.ctx.storage.put("job", job);
		await this.ctx.storage.put("forward_headers", result.data.forward_headers);
		await this.ctx.storage.setAlarm(Date.now());

		return jsonResponse(202, { job_id: jobId, status: "queued" });
	}

	private async handleStatus(): Promise<Response> {
		const job = await this.ctx.storage.get<Job>("job");
		if (!job) {
			return jsonResponse(404, { error: "Job not found" });
		}
		return jsonResponse(200, job);
	}

	private async executeAndDeliver(job: Job): Promise<void> {
		await this.updateStatus("in_progress");

		const forwardHeaders = await this.ctx.storage.get<Record<string, string>>("forward_headers");

		let upstream: UpstreamResponse;
		try {
			const response = await fetch(job.request.target, {
				method: "POST",
				headers: forwardHeaders ?? {},
				body: serializeBody(job.request.body),
			});

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

		await this.ctx.storage.put("upstream_response", upstream);
		await this.ctx.storage.delete("forward_headers");

		const envelope = buildEnvelope(job.id, job.request.target, upstream, new Date().toISOString());

		await this.deliverAllCallbacks(job, envelope);
	}

	private async deliverAllCallbacks(job: Job, envelope: Envelope): Promise<void> {
		const retryPolicy = this.getRetryPolicy(job);

		const results = await Promise.all(
			job.request.callbacks.map((cb) => this.deliverOne(cb, envelope)),
		);

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
			await this.ctx.storage.put(`cb:${i}`, state);
		}

		await this.resolveJobStatus(job);
		if (earliestRetry !== null) {
			await this.ctx.storage.setAlarm(earliestRetry);
		}
	}

	private async retryPendingCallbacks(job: Job): Promise<void> {
		const upstreamResponse = await this.ctx.storage.get<UpstreamResponse>("upstream_response");
		if (!upstreamResponse) return;

		const retryPolicy = this.getRetryPolicy(job);
		const envelope = buildEnvelope(
			job.id,
			job.request.target,
			upstreamResponse,
			new Date().toISOString(),
		);

		const now = Date.now();
		let earliestRetry: number | null = null;

		for (let i = 0; i < job.request.callbacks.length; i++) {
			const state = await this.ctx.storage.get<CallbackState>(`cb:${i}`);
			if (!state || state.status !== "pending") continue;

			if (state.next_retry_at && state.next_retry_at > now) {
				if (earliestRetry === null || state.next_retry_at < earliestRetry) {
					earliestRetry = state.next_retry_at;
				}
				continue;
			}

			const success = await this.deliverOne(job.request.callbacks[i], envelope);
			const newAttempts = state.attempts + 1;

			if (success) {
				await this.ctx.storage.put(`cb:${i}`, {
					status: "delivered",
					attempts: newAttempts,
					next_retry_at: null,
				} satisfies CallbackState);
			} else if (shouldRetry(newAttempts, retryPolicy)) {
				const delay = computeBackoff(state.attempts, retryPolicy);
				const nextRetry = now + delay;
				await this.ctx.storage.put(`cb:${i}`, {
					status: "pending",
					attempts: newAttempts,
					next_retry_at: nextRetry,
				} satisfies CallbackState);
				if (earliestRetry === null || nextRetry < earliestRetry) earliestRetry = nextRetry;
			} else {
				await this.ctx.storage.put(`cb:${i}`, {
					status: "failed",
					attempts: newAttempts,
					next_retry_at: null,
				} satisfies CallbackState);
			}
		}

		await this.resolveJobStatus(job);
		if (earliestRetry !== null) {
			await this.ctx.storage.setAlarm(earliestRetry);
		}
	}

	private async deliverOne(callback: Callback, envelope: Envelope): Promise<boolean> {
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

	private async resolveJobStatus(job: Job): Promise<void> {
		const states: CallbackState[] = [];
		for (let i = 0; i < job.request.callbacks.length; i++) {
			const state = await this.ctx.storage.get<CallbackState>(`cb:${i}`);
			if (state) states.push(state);
		}
		if (states.length === 0) return;

		if (states.every((s) => s.status === "delivered")) {
			await this.updateStatus("completed");
		} else if (
			states.some((s) => s.status === "failed") &&
			!states.some((s) => s.status === "pending")
		) {
			await this.updateStatus("failed");
		}
	}

	private async updateStatus(status: JobStatus): Promise<void> {
		const job = await this.ctx.storage.get<Job>("job");
		if (!job) return;
		job.status = status;
		job.updated_at = new Date().toISOString();
		await this.ctx.storage.put("job", job);
	}

	private getRetryPolicy(job: Job): RetryPolicy {
		return job.request.retry ?? DEFAULT_RETRY_POLICY;
	}
}
