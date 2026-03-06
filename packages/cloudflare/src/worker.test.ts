import type { Job, JobStore, RequestBody } from "@lampas/core";
import { describe, expect, it } from "vitest";
import { handleRequest } from "./worker";

const validRequest = {
	target: "https://api.example.com/data",
	forward_headers: { Authorization: "Bearer tok_123" },
	callbacks: [{ url: "https://hook.example.com/callback" }],
	body: { key: "value" },
};

function makeJob(id: string, request: RequestBody): Job {
	return {
		id,
		status: "queued",
		created_at: "2024-01-01T00:00:00.000Z",
		updated_at: "2024-01-01T00:00:00.000Z",
		request,
	};
}

function mockJobStore(jobs: Map<string, Job> = new Map()): JobStore {
	return {
		async createJob(request: RequestBody): Promise<Job> {
			const job = makeJob("test-job-id", request);
			jobs.set(job.id, job);
			return job;
		},
		async getJob(id: string): Promise<Job | null> {
			return jobs.get(id) ?? null;
		},
		async updateJobStatus(id: string, status: Job["status"]): Promise<void> {
			const job = jobs.get(id);
			if (job) job.status = status;
		},
	};
}

function post(path: string, body: unknown): Request {
	return new Request(`http://localhost${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

function get(path: string): Request {
	return new Request(`http://localhost${path}`, { method: "GET" });
}

// biome-ignore lint/suspicious/noExplicitAny: test helper for json assertions
async function json(res: Response): Promise<any> {
	return res.json();
}

describe("POST /forward", () => {
	it("returns 202 with job_id and status for a valid request", async () => {
		const store = mockJobStore();
		const res = await handleRequest(post("/forward", validRequest), store);

		expect(res.status).toBe(202);
		const body = await json(res);
		expect(body).toEqual({ job_id: "test-job-id", status: "queued" });
	});

	it("returns 400 when body is not valid JSON", async () => {
		const store = mockJobStore();
		const req = new Request("http://localhost/forward", {
			method: "POST",
			body: "not json",
		});
		const res = await handleRequest(req, store);

		expect(res.status).toBe(400);
		const body = await json(res);
		expect(body.error).toBe("Request body must be valid JSON");
	});

	it("returns 400 when target is missing", async () => {
		const store = mockJobStore();
		const { target: _, ...noTarget } = validRequest;
		const res = await handleRequest(post("/forward", noTarget), store);

		expect(res.status).toBe(400);
		const body = await json(res);
		expect(body.error).toBeDefined();
	});

	it("returns 400 when target is not a valid URL", async () => {
		const store = mockJobStore();
		const res = await handleRequest(
			post("/forward", { ...validRequest, target: "not-a-url" }),
			store,
		);

		expect(res.status).toBe(400);
		const body = await json(res);
		expect(body.error).toContain("Target must be a valid URL");
	});

	it("returns 400 when callbacks is empty", async () => {
		const store = mockJobStore();
		const res = await handleRequest(post("/forward", { ...validRequest, callbacks: [] }), store);

		expect(res.status).toBe(400);
		const body = await json(res);
		expect(body.error).toContain("At least one callback is required");
	});

	it("returns 400 when callbacks is missing", async () => {
		const store = mockJobStore();
		const { callbacks: _, ...noCallbacks } = validRequest;
		const res = await handleRequest(post("/forward", noCallbacks), store);

		expect(res.status).toBe(400);
	});

	it("returns 400 when forward_headers is missing", async () => {
		const store = mockJobStore();
		const { forward_headers: _, ...noHeaders } = validRequest;
		const res = await handleRequest(post("/forward", noHeaders), store);

		expect(res.status).toBe(400);
	});
});

describe("GET /jobs/:id", () => {
	it("returns 200 with job data when job exists", async () => {
		const jobs = new Map<string, Job>();
		const store = mockJobStore(jobs);
		// Pre-populate a job
		const job = makeJob("existing-job", validRequest as RequestBody);
		jobs.set("existing-job", job);

		const res = await handleRequest(get("/jobs/existing-job"), store);

		expect(res.status).toBe(200);
		const body = await json(res);
		expect(body.id).toBe("existing-job");
		expect(body.status).toBe("queued");
	});

	it("returns 404 when job does not exist", async () => {
		const store = mockJobStore();
		const res = await handleRequest(get("/jobs/nonexistent"), store);

		expect(res.status).toBe(404);
		const body = await json(res);
		expect(body.error).toBe("Job not found");
	});
});

describe("method not allowed", () => {
	it("returns 405 for GET /forward", async () => {
		const store = mockJobStore();
		const res = await handleRequest(get("/forward"), store);

		expect(res.status).toBe(405);
		const body = await json(res);
		expect(body.error).toBe("Method not allowed");
	});

	it("returns 405 for POST /jobs/:id", async () => {
		const store = mockJobStore();
		const res = await handleRequest(post("/jobs/some-id", {}), store);

		expect(res.status).toBe(405);
		const body = await json(res);
		expect(body.error).toBe("Method not allowed");
	});
});

describe("unknown routes", () => {
	it("returns 404 for unrecognized paths", async () => {
		const store = mockJobStore();
		const res = await handleRequest(get("/unknown"), store);

		expect(res.status).toBe(404);
		const body = await json(res);
		expect(body.error).toBe("Not found");
	});
});

describe("CORS", () => {
	it("returns 204 with CORS headers for OPTIONS preflight", async () => {
		const store = mockJobStore();
		const req = new Request("http://localhost/forward", { method: "OPTIONS" });
		const res = await handleRequest(req, store);

		expect(res.status).toBe(204);
		expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
		expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
		expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Content-Type");
	});

	it("includes CORS headers on error responses", async () => {
		const store = mockJobStore();
		const res = await handleRequest(get("/unknown"), store);

		expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
	});

	it("includes CORS headers on success responses", async () => {
		const store = mockJobStore();
		const res = await handleRequest(post("/forward", validRequest), store);

		expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
	});
});
