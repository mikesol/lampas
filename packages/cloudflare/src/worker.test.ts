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
		// Status could be "queued" or "in_progress" depending on alarm timing
		expect(["queued", "in_progress", "completed", "failed"]).toContain(body.status);
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
