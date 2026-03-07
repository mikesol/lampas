# Job Durable Object Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement the Durable Object that owns the full lifecycle of a Lampas job.

**Architecture:** Worker becomes thin proxy routing to JobDO. DO validates, persists, returns 202, then executes via immediate alarm (not `ctx.waitUntil`). Retries also alarm-driven. Core types/schemas/utilities used throughout; core's `backend.ts` deleted.

**Tech Stack:** Cloudflare Workers + Durable Objects, `@cloudflare/vitest-pool-workers`, `@lampas/core` (zod schemas, `buildEnvelope`, `computeBackoff`, `shouldRetry`)

---

### Task 1: Delete backend.ts and update core

**Files:**
- Delete: `packages/core/src/backend.ts`
- Modify: `packages/core/src/index.ts`

**Step 1: Delete backend.ts**

```bash
rm packages/core/src/backend.ts
```

**Step 2: Remove backend exports from core index**

Edit `packages/core/src/index.ts` — remove the last line:
```ts
export type { JobStore, JobExecutor } from "./backend";
```

Final `index.ts`:
```ts
// @lampas/core — Job schema, envelope, retry logic

export {
	type Envelope,
	EnvelopeSchema,
	type UpstreamResponse,
	buildEnvelope,
} from "./envelope";

export {
	type Callback,
	CallbackSchema,
	type Job,
	JobSchema,
	type JobStatus,
	JobStatusSchema,
	type RequestBody,
	type RequestBodyInput,
	RequestBodySchema,
	type RetryPolicy,
	type RetryPolicyInput,
	RetryPolicySchema,
} from "./job";

export { type RetryState, computeBackoff, shouldRetry } from "./retry";
```

**Step 3: Verify core builds**

```bash
cd packages/core && npx tsc -p tsconfig.json --noEmit
```

**Step 4: Commit**

```bash
git add -A && git commit -m "Remove backend.ts — premature abstraction (#7)"
```

---

### Task 2: Set up cloudflare test infrastructure

**Files:**
- Create: `packages/cloudflare/wrangler.toml`
- Create: `packages/cloudflare/vitest.config.ts`
- Create: `packages/cloudflare/src/env.d.ts`
- Modify: `packages/cloudflare/package.json`
- Modify: `packages/cloudflare/tsconfig.json`
- Modify: `vitest.config.ts` (root)
- Modify: `package.json` (root)

**Step 1: Create wrangler.toml**

```toml
name = "lampas"
main = "src/index.ts"
compatibility_date = "2025-01-01"

[[durable_objects.bindings]]
name = "JOB_DO"
class_name = "JobDO"

[[migrations]]
tag = "v1"
new_classes = ["JobDO"]
```

**Step 2: Create vitest.config.ts for cloudflare**

```ts
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				wrangler: { configPath: "./wrangler.toml" },
			},
		},
	},
});
```

**Step 3: Create env.d.ts for test types**

```ts
declare module "cloudflare:test" {
	interface ProvidedEnv {
		JOB_DO: DurableObjectNamespace;
	}
}
```

**Step 4: Update cloudflare package.json**

Add devDependencies and test script:
```json
{
	"scripts": {
		"build": "tsc -p tsconfig.json",
		"test": "vitest run"
	},
	"devDependencies": {
		"@cloudflare/workers-types": "^4.20260306.1",
		"@cloudflare/vitest-pool-workers": "^0.8.0",
		"wrangler": "^4.0.0"
	}
}
```

**Step 5: Update cloudflare tsconfig.json — exclude test files from build**

```json
{
	"compilerOptions": {
		"target": "ES2022",
		"module": "ES2022",
		"moduleResolution": "bundler",
		"lib": ["ES2022"],
		"types": ["@cloudflare/workers-types"],
		"outDir": "./dist",
		"rootDir": "./src",
		"strict": true,
		"skipLibCheck": true,
		"forceConsistentCasingInFileNames": true,
		"declaration": true,
		"resolveJsonModule": true
	},
	"include": ["src/**/*"],
	"exclude": ["src/**/*.test.ts", "src/env.d.ts"]
}
```

**Step 6: Update root vitest.config.ts — exclude cloudflare**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["packages/*/src/**/*.test.ts"],
		exclude: ["packages/cloudflare/**"],
		passWithNoTests: true,
	},
});
```

**Step 7: Update root package.json test script**

```json
"test": "vitest run && pnpm --filter @lampas/cloudflare test"
```

**Step 8: Install dependencies**

```bash
cd /home/mikesol/Documents/GitHub/lampas/lampas && pnpm install
```

**Step 9: Commit**

```bash
git add -A && git commit -m "Add cloudflare vitest-pool-workers test infrastructure (#7)"
```

---

### Task 3: Write JobDO skeleton + rewrite worker

**Files:**
- Create: `packages/cloudflare/src/job-do.ts`
- Rewrite: `packages/cloudflare/src/worker.ts`
- Rewrite: `packages/cloudflare/src/index.ts`
- Delete: `packages/cloudflare/src/worker.test.ts` (will be rewritten in later task)

**Step 1: Create job-do.ts with minimal skeleton**

```ts
import {
	type Callback,
	type Envelope,
	type Job,
	type JobStatus,
	type RequestBody,
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

		const forwardHeaders =
			await this.ctx.storage.get<Record<string, string>>("forward_headers");

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

		const envelope = buildEnvelope(
			job.id,
			job.request.target,
			upstream,
			new Date().toISOString(),
		);

		await this.deliverAllCallbacks(job, envelope);
	}

	private async deliverAllCallbacks(
		job: Job,
		envelope: Envelope,
	): Promise<void> {
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
				if (earliestRetry === null || nextRetry < earliestRetry)
					earliestRetry = nextRetry;
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
		const upstreamResponse =
			await this.ctx.storage.get<UpstreamResponse>("upstream_response");
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
				if (earliestRetry === null || nextRetry < earliestRetry)
					earliestRetry = nextRetry;
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

	private async deliverOne(
		callback: Callback,
		envelope: Envelope,
	): Promise<boolean> {
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
```

**Step 2: Rewrite worker.ts as thin proxy**

```ts
import type { Env } from "./job-do.js";

function corsHeaders(response: Response): Response {
	response.headers.set("Access-Control-Allow-Origin", "*");
	response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	response.headers.set("Access-Control-Allow-Headers", "Content-Type");
	return response;
}

function errorResponse(status: number, message: string): Response {
	return corsHeaders(
		new Response(JSON.stringify({ error: message }), {
			status,
			headers: { "Content-Type": "application/json" },
		}),
	);
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (request.method === "OPTIONS") {
			return corsHeaders(new Response(null, { status: 204 }));
		}

		const url = new URL(request.url);

		if (url.pathname === "/forward") {
			if (request.method !== "POST") {
				return errorResponse(405, "Method not allowed");
			}
			const jobId = crypto.randomUUID();
			const stub = env.JOB_DO.get(env.JOB_DO.idFromName(jobId));
			const doRequest = new Request("http://do", {
				method: "POST",
				headers: {
					"X-Lampas-Job-Id": jobId,
					"Content-Type":
						request.headers.get("Content-Type") ?? "application/json",
				},
				body: request.body,
			});
			const response = await stub.fetch(doRequest);
			return corsHeaders(
				new Response(response.body, {
					status: response.status,
					headers: response.headers,
				}),
			);
		}

		const jobMatch = url.pathname.match(/^\/jobs\/([^/]+)$/);
		if (jobMatch) {
			if (request.method !== "GET") {
				return errorResponse(405, "Method not allowed");
			}
			const stub = env.JOB_DO.get(env.JOB_DO.idFromName(jobMatch[1]));
			const response = await stub.fetch(
				new Request("http://do", { method: "GET" }),
			);
			return corsHeaders(
				new Response(response.body, {
					status: response.status,
					headers: response.headers,
				}),
			);
		}

		return errorResponse(404, "Not found");
	},
} satisfies ExportedHandler<Env>;
```

**Step 3: Rewrite index.ts**

```ts
// @lampas/cloudflare — Cloudflare Workers + Durable Objects backend

export { JobDO, type CallbackState, type Env } from "./job-do.js";
export { default } from "./worker.js";
```

**Step 4: Delete old worker.test.ts**

```bash
rm packages/cloudflare/src/worker.test.ts
```

**Step 5: Verify build**

```bash
npm run build
```

**Step 6: Commit**

```bash
git add -A && git commit -m "Add JobDO skeleton and rewrite worker as thin proxy (#7)"
```

---

### Task 4: Write DO tests — job creation + status query

**Files:**
- Create: `packages/cloudflare/src/job-do.test.ts`

**Step 1: Write tests**

```ts
import { env, fetchMock, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { CallbackState, JobDO } from "./job-do.js";

const UPSTREAM_ORIGIN = "https://api.example.com";
const UPSTREAM_PATH = "/data";
const UPSTREAM_URL = `${UPSTREAM_ORIGIN}${UPSTREAM_PATH}`;
const CALLBACK_ORIGIN = "https://hook.example.com";
const CALLBACK_PATH = "/callback";
const CALLBACK_URL = `${CALLBACK_ORIGIN}${CALLBACK_PATH}`;

const validRequest = {
	target: UPSTREAM_URL,
	forward_headers: { Authorization: "Bearer tok_123" },
	callbacks: [{ url: CALLBACK_URL }],
	body: { key: "value" },
};

function createStub(jobId = "test-job") {
	return env.JOB_DO.get(env.JOB_DO.idFromName(jobId));
}

function postToStub(
	stub: DurableObjectStub,
	jobId: string,
	// biome-ignore lint/suspicious/noExplicitAny: test helper
	request: any = validRequest,
) {
	return stub.fetch("http://do", {
		method: "POST",
		headers: {
			"X-Lampas-Job-Id": jobId,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(request),
	});
}

function mockUpstream(status = 200, body: unknown = { result: "ok" }) {
	fetchMock
		.get(UPSTREAM_ORIGIN)
		.intercept({ path: UPSTREAM_PATH, method: "POST" })
		.reply(status, JSON.stringify(body), {
			headers: { "content-type": "application/json" },
		});
}

function mockCallback(
	origin = CALLBACK_ORIGIN,
	path = CALLBACK_PATH,
	status = 200,
) {
	fetchMock
		.get(origin)
		.intercept({ path, method: "POST" })
		.reply(status, "ok");
}

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});

afterEach(() => fetchMock.assertNoPendingInterceptors());

describe("job creation", () => {
	it("returns 202 with job_id and queued status", async () => {
		const stub = createStub("create-202");
		const res = await postToStub(stub, "create-202");

		expect(res.status).toBe(202);
		const body = await res.json();
		expect(body).toEqual({ job_id: "create-202", status: "queued" });
	});

	it("persists job with wiped forward_headers", async () => {
		const stub = createStub("persist");
		await postToStub(stub, "persist");

		await runInDurableObject(stub, async (_instance, state) => {
			const job = await state.storage.get("job");
			expect(job).toBeDefined();
			expect(job.id).toBe("persist");
			expect(job.status).toBe("queued");
			expect(job.request.forward_headers).toEqual({});
		});
	});

	it("stores forward_headers separately", async () => {
		const stub = createStub("fwd-hdr");
		await postToStub(stub, "fwd-hdr");

		await runInDurableObject(stub, async (_instance, state) => {
			const headers = await state.storage.get("forward_headers");
			expect(headers).toEqual({ Authorization: "Bearer tok_123" });
		});
	});

	it("returns 400 for invalid request", async () => {
		const stub = createStub("invalid");
		const res = await stub.fetch("http://do", {
			method: "POST",
			headers: {
				"X-Lampas-Job-Id": "invalid",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ target: "not-a-url" }),
		});
		expect(res.status).toBe(400);
	});

	it("returns 400 for non-JSON body", async () => {
		const stub = createStub("bad-json");
		const res = await stub.fetch("http://do", {
			method: "POST",
			headers: { "X-Lampas-Job-Id": "bad-json" },
			body: "not json",
		});
		expect(res.status).toBe(400);
	});
});

describe("status query", () => {
	it("returns job state", async () => {
		const stub = createStub("status-ok");
		await postToStub(stub, "status-ok");

		const res = await stub.fetch("http://do", { method: "GET" });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.id).toBe("status-ok");
		expect(body.status).toBe("queued");
	});

	it("returns 404 for unknown job", async () => {
		const stub = createStub("unknown");
		const res = await stub.fetch("http://do", { method: "GET" });
		expect(res.status).toBe(404);
	});
});

describe("upstream execution", () => {
	it("calls upstream and wipes forward_headers", async () => {
		mockUpstream();
		mockCallback();
		const stub = createStub("wipe");
		await postToStub(stub, "wipe");

		await runInDurableObject(stub, async (instance: JobDO, state) => {
			await instance.alarm();
			expect(await state.storage.get("forward_headers")).toBeUndefined();
		});
	});

	it("stores upstream response", async () => {
		mockUpstream(200, { result: "ok" });
		mockCallback();
		const stub = createStub("upstream-store");
		await postToStub(stub, "upstream-store");

		await runInDurableObject(stub, async (instance: JobDO, state) => {
			await instance.alarm();
			const upstream = await state.storage.get("upstream_response");
			expect(upstream).toBeDefined();
			expect(upstream.status).toBe(200);
		});
	});
});

describe("callback delivery", () => {
	it("delivers envelope and marks job completed", async () => {
		mockUpstream();
		mockCallback();
		const stub = createStub("deliver-ok");
		await postToStub(stub, "deliver-ok");

		await runInDurableObject(stub, async (instance: JobDO, state) => {
			await instance.alarm();
			const job = await state.storage.get("job");
			expect(job.status).toBe("completed");
			const cb: CallbackState = await state.storage.get("cb:0");
			expect(cb.status).toBe("delivered");
			expect(cb.attempts).toBe(1);
		});
	});
});

describe("fan-out", () => {
	it("delivers to multiple callbacks", async () => {
		mockUpstream();
		mockCallback();
		fetchMock
			.get("https://hook2.example.com")
			.intercept({ path: "/cb2", method: "POST" })
			.reply(200, "ok");

		const stub = createStub("fanout");
		await postToStub(stub, "fanout", {
			...validRequest,
			callbacks: [
				{ url: CALLBACK_URL },
				{ url: "https://hook2.example.com/cb2" },
			],
		});

		await runInDurableObject(stub, async (instance: JobDO, state) => {
			await instance.alarm();
			const job = await state.storage.get("job");
			expect(job.status).toBe("completed");
			const cb0: CallbackState = await state.storage.get("cb:0");
			const cb1: CallbackState = await state.storage.get("cb:1");
			expect(cb0.status).toBe("delivered");
			expect(cb1.status).toBe("delivered");
		});
	});
});

describe("retry with alarm", () => {
	it("retries failed callback and succeeds", async () => {
		mockUpstream();
		// First attempt: callback fails
		fetchMock
			.get(CALLBACK_ORIGIN)
			.intercept({ path: CALLBACK_PATH, method: "POST" })
			.reply(500, "error");

		const stub = createStub("retry-ok");
		await postToStub(stub, "retry-ok");

		// Initial execution: upstream ok, callback fails
		await runInDurableObject(stub, async (instance: JobDO, state) => {
			await instance.alarm();
			const cb: CallbackState = await state.storage.get("cb:0");
			expect(cb.status).toBe("pending");
			expect(cb.attempts).toBe(1);
			const job = await state.storage.get("job");
			expect(job.status).toBe("in_progress");
		});

		// Second attempt: callback succeeds
		fetchMock
			.get(CALLBACK_ORIGIN)
			.intercept({ path: CALLBACK_PATH, method: "POST" })
			.reply(200, "ok");

		await runInDurableObject(stub, async (instance: JobDO, state) => {
			// Pretend alarm fired (set next_retry_at to past)
			const cb: CallbackState = await state.storage.get("cb:0");
			await state.storage.put("cb:0", { ...cb, next_retry_at: 0 });
			await instance.alarm();
			const updated: CallbackState = await state.storage.get("cb:0");
			expect(updated.status).toBe("delivered");
			const job = await state.storage.get("job");
			expect(job.status).toBe("completed");
		});
	});
});

describe("retry exhaustion", () => {
	it("marks job failed when retries exhausted", async () => {
		mockUpstream();
		const stub = createStub("exhaust");
		await postToStub(stub, "exhaust", {
			...validRequest,
			retry: { attempts: 2 },
		});

		// Attempt 1: fail
		fetchMock
			.get(CALLBACK_ORIGIN)
			.intercept({ path: CALLBACK_PATH, method: "POST" })
			.reply(500, "error");

		await runInDurableObject(stub, async (instance: JobDO, state) => {
			await instance.alarm();
			const cb: CallbackState = await state.storage.get("cb:0");
			expect(cb.status).toBe("pending");
		});

		// Attempt 2: fail again — exhausted
		fetchMock
			.get(CALLBACK_ORIGIN)
			.intercept({ path: CALLBACK_PATH, method: "POST" })
			.reply(500, "error");

		await runInDurableObject(stub, async (instance: JobDO, state) => {
			const cb: CallbackState = await state.storage.get("cb:0");
			await state.storage.put("cb:0", { ...cb, next_retry_at: 0 });
			await instance.alarm();
			const updated: CallbackState = await state.storage.get("cb:0");
			expect(updated.status).toBe("failed");
			const job = await state.storage.get("job");
			expect(job.status).toBe("failed");
		});
	});
});

describe("upstream failure", () => {
	it("delivers failure envelope when upstream returns 500", async () => {
		fetchMock
			.get(UPSTREAM_ORIGIN)
			.intercept({ path: UPSTREAM_PATH, method: "POST" })
			.reply(500, "Internal Server Error");
		mockCallback();

		const stub = createStub("upstream-fail");
		await postToStub(stub, "upstream-fail");

		await runInDurableObject(stub, async (instance: JobDO, state) => {
			await instance.alarm();
			const upstream = await state.storage.get("upstream_response");
			expect(upstream.status).toBe(500);
			// Callback delivery succeeded, so job is completed
			const job = await state.storage.get("job");
			expect(job.status).toBe("completed");
		});
	});
});
```

**Step 2: Run tests**

```bash
cd packages/cloudflare && npx vitest run
```

Expected: all tests pass.

**Step 3: Commit**

```bash
git add -A && git commit -m "Add DO tests: lifecycle, delivery, retry, fan-out, credential wiping (#7)"
```

---

### Task 5: Write worker integration tests

**Files:**
- Create: `packages/cloudflare/src/worker.test.ts`

**Step 1: Write tests**

```ts
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const validRequest = {
	target: "https://api.example.com/data",
	forward_headers: { Authorization: "Bearer tok_123" },
	callbacks: [{ url: "https://hook.example.com/callback" }],
	body: { key: "value" },
};

describe("POST /forward", () => {
	it("returns 202 with job_id and status", async () => {
		const res = await SELF.fetch("http://localhost/forward", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(validRequest),
		});
		expect(res.status).toBe(202);
		const body = (await res.json()) as { job_id: string; status: string };
		expect(body.job_id).toBeDefined();
		expect(body.status).toBe("queued");
	});

	it("returns 400 for invalid JSON", async () => {
		const res = await SELF.fetch("http://localhost/forward", {
			method: "POST",
			body: "not json",
		});
		expect(res.status).toBe(400);
	});

	it("includes CORS headers", async () => {
		const res = await SELF.fetch("http://localhost/forward", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(validRequest),
		});
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
	});
});

describe("GET /jobs/:id", () => {
	it("returns job state after creation", async () => {
		const createRes = await SELF.fetch("http://localhost/forward", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(validRequest),
		});
		const { job_id } = (await createRes.json()) as { job_id: string };

		const res = await SELF.fetch(`http://localhost/jobs/${job_id}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { id: string; status: string };
		expect(body.id).toBe(job_id);
		expect(body.status).toBe("queued");
	});

	it("returns 404 for unknown job", async () => {
		const res = await SELF.fetch("http://localhost/jobs/nonexistent");
		expect(res.status).toBe(404);
	});
});

describe("routing", () => {
	it("returns 404 for unknown paths", async () => {
		const res = await SELF.fetch("http://localhost/unknown");
		expect(res.status).toBe(404);
	});

	it("returns 405 for wrong methods", async () => {
		const res = await SELF.fetch("http://localhost/forward");
		expect(res.status).toBe(405);
	});

	it("returns 204 for OPTIONS preflight", async () => {
		const res = await SELF.fetch("http://localhost/forward", {
			method: "OPTIONS",
		});
		expect(res.status).toBe(204);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
	});
});
```

**Step 2: Run all tests**

```bash
cd packages/cloudflare && npx vitest run
```

**Step 3: Commit**

```bash
git add -A && git commit -m "Add worker integration tests (#7)"
```

---

### Task 6: Final verification

**Step 1: Run full build and checks**

```bash
npm run build && npm run check && npm test
```

**Step 2: Fix any issues found**

Address type errors, lint issues, or test failures.

**Step 3: Final commit if needed**

```bash
git add -A && git commit -m "Fix build/lint issues (#7)"
```
