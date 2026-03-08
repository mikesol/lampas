# E2E Test Suite Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a true end-to-end test suite that exercises the full Lampas flow — real HTTP calls through wrangler dev to mock upstream and callback servers on localhost.

**Architecture:** Tests run in Vitest with standard Node pool (not Workers pool). A `wrangler dev` subprocess serves the Lampas worker on port 8787. Mock upstream (port 9001) and mock callback (port 9002) are plain `http.createServer` instances. Tests POST to the worker, the worker fetches from mock upstream, delivers envelopes to mock callback, and tests assert on what the callback received.

**Tech Stack:** Vitest (Node pool), wrangler dev, Node `http.createServer`, `node:child_process`

---

### Task 1: Vitest E2E config and npm scripts

**Files:**
- Create: `packages/cloudflare/vitest.e2e.config.ts`
- Modify: `packages/cloudflare/package.json`
- Modify: `package.json` (root)

**Step 1: Create the E2E vitest config**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/e2e/**/*.test.ts"],
		testTimeout: 30000,
		hookTimeout: 30000,
	},
});
```

**Step 2: Add `test:e2e` script to cloudflare package.json**

In `packages/cloudflare/package.json`, add to `"scripts"`:
```json
"test:e2e": "vitest run --config vitest.e2e.config.ts"
```

**Step 3: Wire E2E tests into root test script**

In `package.json` (root), change the `"test"` script to:
```json
"test": "vitest run && pnpm --filter @lampas/cloudflare test && pnpm --filter @lampas/cloudflare test:e2e"
```

**Step 4: Run `npm run build` to verify nothing is broken**

Run: `cd /home/mikesol/Documents/GitHub/lampas/lampas && npm run build`
Expected: SUCCESS (no E2E tests exist yet, config is just created)

**Step 5: Commit**

```bash
git add packages/cloudflare/vitest.e2e.config.ts packages/cloudflare/package.json package.json
git commit -m "feat(e2e): add vitest E2E config and test:e2e script"
```

---

### Task 2: E2E test helpers — wrangler lifecycle

**Files:**
- Create: `packages/cloudflare/src/e2e/helpers.ts`

**Step 1: Write `startWorker()` helper**

This spawns `wrangler dev` and waits for it to be ready:

```ts
import { type ChildProcess, spawn } from "node:child_process";
import http from "node:http";

const WORKER_PORT = 8787;
const WORKER_BASE = `http://localhost:${WORKER_PORT}`;

/** Spawns wrangler dev and waits until it responds to HTTP. */
export async function startWorker(): Promise<ChildProcess> {
	const proc = spawn("npx", ["wrangler", "dev", "--port", String(WORKER_PORT)], {
		cwd: new URL("../..", import.meta.url).pathname,
		stdio: "pipe",
		env: { ...process.env, NODE_ENV: "test" },
	});

	proc.stderr?.on("data", (chunk: Buffer) => {
		const msg = chunk.toString();
		if (process.env.DEBUG_E2E) console.error("[wrangler]", msg);
	});

	await waitForReady(WORKER_BASE, 15000);
	return proc;
}

async function waitForReady(url: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${url}/forward`);
			// Any response (even 405) means the server is up
			if (res.status > 0) return;
		} catch {
			// not ready yet
		}
		await new Promise((r) => setTimeout(r, 200));
	}
	throw new Error(`wrangler dev did not become ready within ${timeoutMs}ms`);
}

/** Convenience wrapper for fetch against the worker. */
export function lampas(path: string, options?: RequestInit): Promise<Response> {
	return fetch(`${WORKER_BASE}${path}`, options);
}
```

**Step 2: Verify the file compiles**

Run: `cd /home/mikesol/Documents/GitHub/lampas/lampas && npx tsc --noEmit --project packages/cloudflare/tsconfig.json --skipLibCheck 2>&1 || echo "Check compile errors"`

Note: The E2E files use Node types (`node:child_process`, `node:http`), not Cloudflare Workers types. We may need to exclude `src/e2e/**` from the cloudflare tsconfig or handle this differently. If there's a compile error, add `"exclude": ["src/**/*.test.ts", "src/env.d.ts", "src/e2e/**"]` to `packages/cloudflare/tsconfig.json`.

**Step 3: Commit**

```bash
git add packages/cloudflare/src/e2e/helpers.ts
git commit -m "feat(e2e): add wrangler dev lifecycle helper"
```

---

### Task 3: E2E test helpers — mock upstream server

**Files:**
- Modify: `packages/cloudflare/src/e2e/helpers.ts`

**Step 1: Add `createMockUpstream()`**

Append to `helpers.ts`:

```ts
export type RequestHandler = (
	req: http.IncomingMessage,
	res: http.ServerResponse,
) => void;

export interface MockUpstream {
	server: http.Server;
	port: number;
	setHandler: (handler: RequestHandler) => void;
	close: () => Promise<void>;
}

const DEFAULT_UPSTREAM_PORT = 9001;

/** Default handler: returns 200 JSON {"result":"ok"}. */
function defaultUpstreamHandler(_req: http.IncomingMessage, res: http.ServerResponse) {
	res.writeHead(200, { "content-type": "application/json" });
	res.end(JSON.stringify({ result: "ok" }));
}

/** Creates a mock upstream HTTP server with a configurable handler. */
export async function createMockUpstream(
	port = DEFAULT_UPSTREAM_PORT,
): Promise<MockUpstream> {
	let handler: RequestHandler = defaultUpstreamHandler;

	const server = http.createServer((req, res) => handler(req, res));

	await new Promise<void>((resolve) => server.listen(port, resolve));

	return {
		server,
		port,
		setHandler(h: RequestHandler) {
			handler = h;
		},
		close() {
			return new Promise<void>((resolve, reject) =>
				server.close((err) => (err ? reject(err) : resolve())),
			);
		},
	};
}
```

**Step 2: Commit**

```bash
git add packages/cloudflare/src/e2e/helpers.ts
git commit -m "feat(e2e): add mock upstream server helper"
```

---

### Task 4: E2E test helpers — mock callback server

**Files:**
- Modify: `packages/cloudflare/src/e2e/helpers.ts`

**Step 1: Add `createMockCallback()`**

Append to `helpers.ts`:

```ts
export interface ReceivedRequest {
	path: string;
	headers: http.IncomingHttpHeaders;
	body: string;
}

export interface MockCallback {
	server: http.Server;
	port: number;
	/** Configure response status for a path. Default is 200. */
	setStatus: (path: string, status: number) => void;
	/**
	 * Configure a sequence of statuses for a path.
	 * E.g. [500, 500, 200] means first two calls get 500, third gets 200.
	 */
	setStatusSequence: (path: string, statuses: number[]) => void;
	/** Returns a promise that resolves when the next POST arrives on the given path. */
	waitForRequest: (path: string, timeoutMs?: number) => Promise<ReceivedRequest>;
	/** Returns all requests received on a given path. */
	getRequests: (path: string) => ReceivedRequest[];
	/** Resets all captured requests and configured statuses. */
	reset: () => void;
	close: () => Promise<void>;
}

const DEFAULT_CALLBACK_PORT = 9002;

/** Creates a mock callback server that captures incoming POSTs and resolves promises. */
export async function createMockCallback(
	port = DEFAULT_CALLBACK_PORT,
): Promise<MockCallback> {
	const requests = new Map<string, ReceivedRequest[]>();
	const waiters = new Map<string, Array<(req: ReceivedRequest) => void>>();
	const statusOverrides = new Map<string, number>();
	const statusSequences = new Map<string, number[]>();

	const server = http.createServer((req, res) => {
		const path = req.url ?? "/";
		let body = "";
		req.on("data", (chunk: Buffer) => {
			body += chunk.toString();
		});
		req.on("end", () => {
			const received: ReceivedRequest = { path, headers: req.headers, body };

			if (!requests.has(path)) requests.set(path, []);
			requests.get(path)!.push(received);

			// Determine status: sequence takes priority, then override, then 200
			let status = 200;
			const seq = statusSequences.get(path);
			if (seq && seq.length > 0) {
				status = seq.shift()!;
			} else if (statusOverrides.has(path)) {
				status = statusOverrides.get(path)!;
			}

			res.writeHead(status);
			res.end("ok");

			// Resolve any waiters
			const pathWaiters = waiters.get(path);
			if (pathWaiters && pathWaiters.length > 0) {
				const resolve = pathWaiters.shift()!;
				resolve(received);
			}
		});
	});

	await new Promise<void>((resolve) => server.listen(port, resolve));

	return {
		server,
		port,
		setStatus(path: string, status: number) {
			statusOverrides.set(path, status);
		},
		setStatusSequence(path: string, statuses: number[]) {
			statusSequences.set(path, [...statuses]);
		},
		waitForRequest(path: string, timeoutMs = 10000): Promise<ReceivedRequest> {
			// Check if we already have an unwaited request
			const existing = requests.get(path);
			const waiterCount = waiters.get(path)?.length ?? 0;
			if (existing && existing.length > waiterCount) {
				return Promise.resolve(existing[waiterCount]);
			}

			return new Promise<ReceivedRequest>((resolve, reject) => {
				const timer = setTimeout(() => {
					reject(new Error(`Timed out waiting for request on ${path} after ${timeoutMs}ms`));
				}, timeoutMs);

				if (!waiters.has(path)) waiters.set(path, []);
				waiters.get(path)!.push((req) => {
					clearTimeout(timer);
					resolve(req);
				});
			});
		},
		getRequests(path: string): ReceivedRequest[] {
			return requests.get(path) ?? [];
		},
		reset() {
			requests.clear();
			waiters.clear();
			statusOverrides.clear();
			statusSequences.clear();
		},
		close() {
			return new Promise<void>((resolve, reject) =>
				server.close((err) => (err ? reject(err) : resolve())),
			);
		},
	};
}
```

**Step 2: Commit**

```bash
git add packages/cloudflare/src/e2e/helpers.ts
git commit -m "feat(e2e): add mock callback server helper"
```

---

### Task 5: E2E test — happy path

**Files:**
- Create: `packages/cloudflare/src/e2e/e2e.test.ts`

**Step 1: Write the happy path test**

```ts
import { type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	type MockCallback,
	type MockUpstream,
	createMockCallback,
	createMockUpstream,
	lampas,
	startWorker,
} from "./helpers.js";

let worker: ChildProcess;
let upstream: MockUpstream;
let callback: MockCallback;

const UPSTREAM_PORT = 9001;
const CALLBACK_PORT = 9002;
const UPSTREAM_URL = `http://localhost:${UPSTREAM_PORT}/api`;
const CALLBACK_URL = `http://localhost:${CALLBACK_PORT}/hook`;

beforeAll(async () => {
	upstream = await createMockUpstream(UPSTREAM_PORT);
	callback = await createMockCallback(CALLBACK_PORT);
	worker = await startWorker();
});

afterAll(async () => {
	worker?.kill();
	await upstream?.close();
	await callback?.close();
});

describe("happy path", () => {
	it("POST /forward → upstream called → callback receives envelope → job completed", async () => {
		callback.reset();

		const res = await lampas("/forward", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				target: UPSTREAM_URL,
				forward_headers: { Authorization: "Bearer test-token" },
				callbacks: [{ url: CALLBACK_URL }],
				retry: { attempts: 1, initial_delay_ms: 100, max_delay_ms: 200 },
				body: { hello: "world" },
			}),
		});

		expect(res.status).toBe(202);
		const { job_id, status } = (await res.json()) as { job_id: string; status: string };
		expect(job_id).toBeDefined();
		expect(status).toBe("queued");

		// Wait for callback to receive the envelope
		const received = await callback.waitForRequest("/hook");
		const envelope = JSON.parse(received.body);

		expect(envelope.lampas_job_id).toBe(job_id);
		expect(envelope.lampas_status).toBe("completed");
		expect(envelope.lampas_target).toBe(UPSTREAM_URL);
		expect(envelope.response_status).toBe(200);
		expect(envelope.response_body).toEqual({ result: "ok" });

		// Confirm job status via GET
		const statusRes = await lampas(`/jobs/${job_id}`);
		expect(statusRes.status).toBe(200);
		const job = (await statusRes.json()) as { status: string };
		expect(job.status).toBe("completed");
	});
});
```

**Step 2: Run the test**

Run: `cd /home/mikesol/Documents/GitHub/lampas/lampas && pnpm --filter @lampas/cloudflare test:e2e`
Expected: PASS

**Step 3: Commit**

```bash
git add packages/cloudflare/src/e2e/e2e.test.ts
git commit -m "feat(e2e): add happy path test"
```

---

### Task 6: E2E test — callback retry

**Files:**
- Modify: `packages/cloudflare/src/e2e/e2e.test.ts`

**Step 1: Add callback retry test**

Append to `e2e.test.ts`:

```ts
describe("callback retry", () => {
	it("retries failed callback and eventually succeeds", async () => {
		callback.reset();
		// First call: 500, second call: 200
		callback.setStatusSequence("/hook", [500, 200]);

		const res = await lampas("/forward", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				target: UPSTREAM_URL,
				forward_headers: {},
				callbacks: [{ url: CALLBACK_URL }],
				retry: { attempts: 3, initial_delay_ms: 100, max_delay_ms: 200 },
				body: { test: "retry" },
			}),
		});

		const { job_id } = (await res.json()) as { job_id: string };

		// Wait for the second (successful) delivery
		// First delivery fails (500), alarm fires, second delivery succeeds (200)
		// We need to wait for 2 requests total
		await callback.waitForRequest("/hook"); // 1st attempt (500)
		await callback.waitForRequest("/hook"); // 2nd attempt (200)

		const requests = callback.getRequests("/hook");
		expect(requests.length).toBe(2);

		// Verify envelope on the second (successful) attempt
		const envelope = JSON.parse(requests[1].body);
		expect(envelope.lampas_job_id).toBe(job_id);

		// Confirm job completed
		const statusRes = await lampas(`/jobs/${job_id}`);
		const job = (await statusRes.json()) as { status: string };
		expect(job.status).toBe("completed");
	});
});
```

**Step 2: Run the test**

Run: `cd /home/mikesol/Documents/GitHub/lampas/lampas && pnpm --filter @lampas/cloudflare test:e2e`
Expected: PASS

**Step 3: Commit**

```bash
git add packages/cloudflare/src/e2e/e2e.test.ts
git commit -m "feat(e2e): add callback retry test"
```

---

### Task 7: E2E test — callback failure (retries exhausted)

**Files:**
- Modify: `packages/cloudflare/src/e2e/e2e.test.ts`

**Step 1: Add callback failure test**

```ts
describe("callback failure", () => {
	it("marks job failed when callback retries exhausted", async () => {
		callback.reset();
		callback.setStatus("/hook", 500); // Always fail

		const res = await lampas("/forward", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				target: UPSTREAM_URL,
				forward_headers: {},
				callbacks: [{ url: CALLBACK_URL }],
				retry: { attempts: 2, initial_delay_ms: 100, max_delay_ms: 200 },
				body: { test: "failure" },
			}),
		});

		const { job_id } = (await res.json()) as { job_id: string };

		// Wait for all retry attempts
		await callback.waitForRequest("/hook"); // attempt 1
		await callback.waitForRequest("/hook"); // attempt 2

		// Poll for failed status (retries exhausted, alarm needs to fire)
		const deadline = Date.now() + 10000;
		let jobStatus = "";
		while (Date.now() < deadline) {
			const statusRes = await lampas(`/jobs/${job_id}`);
			const job = (await statusRes.json()) as { status: string };
			jobStatus = job.status;
			if (jobStatus === "failed") break;
			await new Promise((r) => setTimeout(r, 200));
		}
		expect(jobStatus).toBe("failed");
	});
});
```

**Step 2: Run the test**

Run: `cd /home/mikesol/Documents/GitHub/lampas/lampas && pnpm --filter @lampas/cloudflare test:e2e`
Expected: PASS

**Step 3: Commit**

```bash
git add packages/cloudflare/src/e2e/e2e.test.ts
git commit -m "feat(e2e): add callback failure test"
```

---

### Task 8: E2E test — fan-out (3 callbacks)

**Files:**
- Modify: `packages/cloudflare/src/e2e/e2e.test.ts`

**Step 1: Add fan-out test**

```ts
describe("fan-out", () => {
	it("delivers envelope to all 3 callbacks", async () => {
		callback.reset();

		const res = await lampas("/forward", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				target: UPSTREAM_URL,
				forward_headers: {},
				callbacks: [
					{ url: `http://localhost:${CALLBACK_PORT}/hook1` },
					{ url: `http://localhost:${CALLBACK_PORT}/hook2` },
					{ url: `http://localhost:${CALLBACK_PORT}/hook3` },
				],
				retry: { attempts: 1, initial_delay_ms: 100, max_delay_ms: 200 },
				body: { test: "fanout" },
			}),
		});

		const { job_id } = (await res.json()) as { job_id: string };

		// Wait for all 3 callbacks
		const [r1, r2, r3] = await Promise.all([
			callback.waitForRequest("/hook1"),
			callback.waitForRequest("/hook2"),
			callback.waitForRequest("/hook3"),
		]);

		// All 3 receive the same envelope
		for (const received of [r1, r2, r3]) {
			const envelope = JSON.parse(received.body);
			expect(envelope.lampas_job_id).toBe(job_id);
			expect(envelope.lampas_status).toBe("completed");
			expect(envelope.response_status).toBe(200);
		}

		// Confirm job completed
		const statusRes = await lampas(`/jobs/${job_id}`);
		const job = (await statusRes.json()) as { status: string };
		expect(job.status).toBe("completed");
	});
});
```

**Step 2: Run the test**

Run: `cd /home/mikesol/Documents/GitHub/lampas/lampas && pnpm --filter @lampas/cloudflare test:e2e`
Expected: PASS

**Step 3: Commit**

```bash
git add packages/cloudflare/src/e2e/e2e.test.ts
git commit -m "feat(e2e): add fan-out test with 3 callbacks"
```

---

### Task 9: E2E test — validation errors

**Files:**
- Modify: `packages/cloudflare/src/e2e/e2e.test.ts`

**Step 1: Add validation error tests**

```ts
describe("validation errors", () => {
	it("returns 400 for malformed JSON", async () => {
		const res = await lampas("/forward", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "not json",
		});
		expect(res.status).toBe(400);
	});

	it("returns 400 for missing target", async () => {
		const res = await lampas("/forward", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				forward_headers: {},
				callbacks: [{ url: CALLBACK_URL }],
			}),
		});
		expect(res.status).toBe(400);
	});

	it("returns 400 for invalid target URL", async () => {
		const res = await lampas("/forward", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				target: "not-a-url",
				forward_headers: {},
				callbacks: [{ url: CALLBACK_URL }],
			}),
		});
		expect(res.status).toBe(400);
	});

	it("returns 400 for empty callbacks array", async () => {
		const res = await lampas("/forward", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				target: UPSTREAM_URL,
				forward_headers: {},
				callbacks: [],
			}),
		});
		expect(res.status).toBe(400);
	});
});
```

**Step 2: Run the test**

Run: `cd /home/mikesol/Documents/GitHub/lampas/lampas && pnpm --filter @lampas/cloudflare test:e2e`
Expected: PASS

**Step 3: Commit**

```bash
git add packages/cloudflare/src/e2e/e2e.test.ts
git commit -m "feat(e2e): add validation error tests"
```

---

### Task 10: E2E test — job status query

**Files:**
- Modify: `packages/cloudflare/src/e2e/e2e.test.ts`

**Step 1: Add job status query tests**

```ts
describe("job status query", () => {
	it("returns 404 for nonexistent job", async () => {
		const res = await lampas("/jobs/nonexistent-id-12345");
		expect(res.status).toBe(404);
	});

	it("returns queued status immediately after creation", async () => {
		callback.reset();

		const res = await lampas("/forward", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				target: UPSTREAM_URL,
				forward_headers: {},
				callbacks: [{ url: CALLBACK_URL }],
				retry: { attempts: 1, initial_delay_ms: 100, max_delay_ms: 200 },
				body: null,
			}),
		});

		const { job_id } = (await res.json()) as { job_id: string };

		// Job has an id and a valid status
		const statusRes = await lampas(`/jobs/${job_id}`);
		expect(statusRes.status).toBe(200);
		const job = (await statusRes.json()) as { id: string; status: string };
		expect(job.id).toBe(job_id);
		expect(["queued", "in_progress", "completed"]).toContain(job.status);

		// Wait for completion to keep test isolated
		await callback.waitForRequest("/hook");
	});
});
```

**Step 2: Run the test**

Run: `cd /home/mikesol/Documents/GitHub/lampas/lampas && pnpm --filter @lampas/cloudflare test:e2e`
Expected: PASS

**Step 3: Commit**

```bash
git add packages/cloudflare/src/e2e/e2e.test.ts
git commit -m "feat(e2e): add job status query tests"
```

---

### Task 11: E2E test — verbatim non-JSON response

**Files:**
- Modify: `packages/cloudflare/src/e2e/e2e.test.ts`

**Step 1: Add verbatim response test**

```ts
describe("verbatim response", () => {
	it("preserves non-JSON upstream body in envelope", async () => {
		callback.reset();

		// Configure upstream to return plain text
		upstream.setHandler((_req, res) => {
			res.writeHead(200, { "content-type": "text/plain", "x-custom": "header-value" });
			res.end("This is raw text, not JSON.");
		});

		const res = await lampas("/forward", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				target: UPSTREAM_URL,
				forward_headers: {},
				callbacks: [{ url: CALLBACK_URL }],
				retry: { attempts: 1, initial_delay_ms: 100, max_delay_ms: 200 },
				body: null,
			}),
		});

		const { job_id } = (await res.json()) as { job_id: string };

		const received = await callback.waitForRequest("/hook");
		const envelope = JSON.parse(received.body);

		expect(envelope.lampas_job_id).toBe(job_id);
		expect(envelope.response_status).toBe(200);
		expect(envelope.response_body).toBe("This is raw text, not JSON.");
		expect(envelope.response_headers["content-type"]).toBe("text/plain");
		expect(envelope.response_headers["x-custom"]).toBe("header-value");

		// Reset upstream to default handler for subsequent tests
		upstream.setHandler((_req, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ result: "ok" }));
		});
	});
});
```

**Step 2: Run the test**

Run: `cd /home/mikesol/Documents/GitHub/lampas/lampas && pnpm --filter @lampas/cloudflare test:e2e`
Expected: PASS

**Step 3: Commit**

```bash
git add packages/cloudflare/src/e2e/e2e.test.ts
git commit -m "feat(e2e): add verbatim non-JSON response test"
```

---

### Task 12: Exclude E2E files from cloudflare tsconfig

**Files:**
- Modify: `packages/cloudflare/tsconfig.json`

E2E tests use Node types (`node:child_process`, `node:http`) which conflict with Cloudflare Workers types. They must be excluded from the cloudflare build.

**Step 1: Update tsconfig exclude**

Change the `"exclude"` array in `packages/cloudflare/tsconfig.json` to:
```json
"exclude": ["src/**/*.test.ts", "src/env.d.ts", "src/e2e/**"]
```

**Step 2: Verify build still works**

Run: `cd /home/mikesol/Documents/GitHub/lampas/lampas && npm run build`
Expected: SUCCESS

**Step 3: Run full test suite**

Run: `cd /home/mikesol/Documents/GitHub/lampas/lampas && npm run build && npm run check && npm run test`
Expected: All pass

**Step 4: Commit**

```bash
git add packages/cloudflare/tsconfig.json
git commit -m "chore: exclude E2E tests from cloudflare build tsconfig"
```

---

### Task 13: Final verification

**Step 1: Run the full validation suite**

Run: `cd /home/mikesol/Documents/GitHub/lampas/lampas && npm run build && npm run check && npm run test`
Expected: All pass — build, lint, unit tests, and E2E tests.

**Step 2: Verify all 7 scenarios pass**

Run: `cd /home/mikesol/Documents/GitHub/lampas/lampas && pnpm --filter @lampas/cloudflare test:e2e -- --reporter=verbose`
Expected: All 7 scenario groups pass:
- happy path
- callback retry
- callback failure
- fan-out
- validation errors
- job status query
- verbatim response

### Notes for the implementer

- **Port conflicts**: If ports 8787, 9001, or 9002 are in use, tests will fail. These are localhost-only ports used exclusively for testing.
- **Timing**: The retry and failure tests depend on alarms firing. With `initial_delay_ms: 100` the tests should complete quickly, but the 10s timeout on `waitForRequest` provides safety margin.
- **`waitForRequest` semantics**: The helper tracks all received requests and resolves promises in order. Calling `waitForRequest("/hook")` twice awaits the 1st and 2nd requests respectively.
- **Test isolation**: Each test calls `callback.reset()` to clear state. The upstream handler is reset after the verbatim test. Tests run sequentially (Vitest default for a single file).
- **Task 12 ordering**: The tsconfig exclusion in Task 12 may actually be needed before Task 5 compiles. The implementer should move it earlier if `tsc --noEmit` fails on the E2E files during Task 2.
