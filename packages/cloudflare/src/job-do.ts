import { type Job, RequestBodySchema, type SsrfPolicy, parseSsrfPolicy } from "@lampas/core";
import { type CallbackState, executeAndDeliver, retryPendingCallbacks } from "./delivery.js";
import { jsonResponse } from "./http.js";
import { validateRequestSsrf } from "./ssrf-guard.js";

export type { CallbackState };

/** Cloudflare Worker environment bindings. */
export interface Env {
	JOB_DO: DurableObjectNamespace;
	SSRF_BLOCK_PRIVATE?: string;
	SSRF_ALLOWLIST?: string;
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
			await executeAndDeliver(this.ctx.storage, job);
		} else if (job.status === "in_progress") {
			await retryPendingCallbacks(this.ctx.storage, job);
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

		const ssrfCheck = await validateRequestSsrf(
			result.data.target,
			result.data.callbacks,
			this.getSsrfPolicy(),
		);
		if (!ssrfCheck.ok) {
			return jsonResponse(400, { error: `SSRF blocked: ${ssrfCheck.reason}` });
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

	private getSsrfPolicy(): SsrfPolicy {
		return parseSsrfPolicy(this.env.SSRF_BLOCK_PRIVATE, this.env.SSRF_ALLOWLIST);
	}
}
