import type { ChildProcess } from "node:child_process";
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
	it("POST /forward -> upstream -> callback -> completed", async () => {
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

		const received = await callback.waitForRequest("/hook");
		const envelope = JSON.parse(received.body);
		expect(envelope.lampas_job_id).toBe(job_id);
		expect(envelope.lampas_status).toBe("completed");
		expect(envelope.lampas_target).toBe(UPSTREAM_URL);
		expect(envelope.response_status).toBe(200);
		expect(envelope.response_body).toEqual({ result: "ok" });

		const statusRes = await lampas(`/jobs/${job_id}`);
		expect(statusRes.status).toBe(200);
		const job = (await statusRes.json()) as { status: string };
		expect(job.status).toBe("completed");
	});
});

describe("callback retry", () => {
	it("retries failed callback and eventually succeeds", async () => {
		callback.reset();
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

		await callback.waitForRequest("/hook"); // attempt 1 (500)
		await callback.waitForRequest("/hook"); // attempt 2 (200)

		const requests = callback.getRequests("/hook");
		expect(requests.length).toBe(2);

		const envelope = JSON.parse(requests[1].body);
		expect(envelope.lampas_job_id).toBe(job_id);

		const statusRes = await lampas(`/jobs/${job_id}`);
		const job = (await statusRes.json()) as { status: string };
		expect(job.status).toBe("completed");
	});
});

describe("callback failure", () => {
	it("marks job failed when retries exhausted", async () => {
		callback.reset();
		callback.setStatus("/hook", 500);

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

		await callback.waitForRequest("/hook"); // attempt 1
		await callback.waitForRequest("/hook"); // attempt 2

		// Poll for failed status
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

		const [r1, r2, r3] = await Promise.all([
			callback.waitForRequest("/hook1"),
			callback.waitForRequest("/hook2"),
			callback.waitForRequest("/hook3"),
		]);

		for (const received of [r1, r2, r3]) {
			const envelope = JSON.parse(received.body);
			expect(envelope.lampas_job_id).toBe(job_id);
			expect(envelope.lampas_status).toBe("completed");
			expect(envelope.response_status).toBe(200);
		}

		const statusRes = await lampas(`/jobs/${job_id}`);
		const job = (await statusRes.json()) as { status: string };
		expect(job.status).toBe("completed");
	});
});

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
			body: JSON.stringify({ forward_headers: {}, callbacks: [{ url: CALLBACK_URL }] }),
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

describe("job status query", () => {
	it("returns 404 for nonexistent job", async () => {
		const res = await lampas("/jobs/nonexistent-id-12345");
		expect(res.status).toBe(404);
	});

	it("returns valid status after creation", async () => {
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

		const statusRes = await lampas(`/jobs/${job_id}`);
		expect(statusRes.status).toBe(200);
		const job = (await statusRes.json()) as { id: string; status: string };
		expect(job.id).toBe(job_id);
		expect(["queued", "in_progress", "completed"]).toContain(job.status);

		await callback.waitForRequest("/hook");
	});
});

describe("verbatim response", () => {
	it("preserves non-JSON upstream body in envelope", async () => {
		callback.reset();
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

		// Reset upstream to default JSON handler
		upstream.setHandler((_req, res) => {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ result: "ok" }));
		});
	});
});
