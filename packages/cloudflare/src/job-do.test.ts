import { env, fetchMock, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { CallbackState, JobDO } from "./job-do.js";

const UPSTREAM_ORIGIN = "https://api.example.com";
const UPSTREAM_PATH = "/data";
const UPSTREAM_URL = `${UPSTREAM_ORIGIN}${UPSTREAM_PATH}`;
const CB_ORIGIN = "https://hook.example.com";
const CB_PATH = "/callback";
const CB_URL = `${CB_ORIGIN}${CB_PATH}`;
const validReq = {
	target: UPSTREAM_URL,
	forward_headers: { Authorization: "Bearer tok_123" },
	callbacks: [{ url: CB_URL }],
	body: { key: "value" },
};
type AnyRec = Record<string, unknown>;
const stub = (id: string) => env.JOB_DO.get(env.JOB_DO.idFromName(id));

/** POST to the DO and cancel the auto-scheduled alarm so tests control timing. */
async function createJob(
	inst: JobDO,
	st: DurableObjectState,
	id: string,
	// biome-ignore lint/suspicious/noExplicitAny: test helper
	req: any = validReq,
): Promise<Response> {
	const res = await inst.fetch(
		new Request("http://do", {
			method: "POST",
			headers: { "X-Lampas-Job-Id": id, "Content-Type": "application/json" },
			body: JSON.stringify(req),
		}),
	);
	await st.storage.deleteAlarm();
	return res;
}

function mockUpstream(status = 200, body: unknown = { result: "ok" }, method = "POST") {
	fetchMock
		.get(UPSTREAM_ORIGIN)
		.intercept({ path: UPSTREAM_PATH, method })
		.reply(status, JSON.stringify(body), {
			headers: { "content-type": "application/json" },
		});
}

function mockCb(origin = CB_ORIGIN, path = CB_PATH, status = 200) {
	fetchMock.get(origin).intercept({ path, method: "POST" }).reply(status, "ok");
}

function mockCbFail() {
	fetchMock.get(CB_ORIGIN).intercept({ path: CB_PATH, method: "POST" }).reply(500, "error");
}

beforeAll(() => {
	fetchMock.activate();
	fetchMock.disableNetConnect();
});
afterEach(() => fetchMock.assertNoPendingInterceptors());

describe("job creation", () => {
	it("returns 202 with job_id and queued status", async () => {
		const s = stub("create-202");
		const res = await runInDurableObject(s, (i: JobDO, st) => createJob(i, st, "create-202"));
		expect(res.status).toBe(202);
		expect(await res.json()).toEqual({ job_id: "create-202", status: "queued" });
	});

	it("persists job with wiped forward_headers", async () => {
		const s = stub("persist");
		await runInDurableObject(s, async (i: JobDO, st) => {
			await createJob(i, st, "persist");
			const job = (await st.storage.get("job")) as AnyRec;
			expect(job).toBeDefined();
			expect(job.id).toBe("persist");
			expect(job.status).toBe("queued");
			expect((job.request as AnyRec).forward_headers).toEqual({});
		});
	});

	it("stores forward_headers separately", async () => {
		const s = stub("fwd-hdr");
		await runInDurableObject(s, async (i: JobDO, st) => {
			await createJob(i, st, "fwd-hdr");
			expect(await st.storage.get("forward_headers")).toEqual({
				Authorization: "Bearer tok_123",
			});
		});
	});

	it("returns 400 for invalid request", async () => {
		const s = stub("invalid");
		const res = await runInDurableObject(s, (i: JobDO) =>
			i.fetch(
				new Request("http://do", {
					method: "POST",
					headers: { "X-Lampas-Job-Id": "invalid", "Content-Type": "application/json" },
					body: JSON.stringify({ target: "not-a-url" }),
				}),
			),
		);
		expect(res.status).toBe(400);
	});

	it("returns 400 for non-JSON body", async () => {
		const s = stub("bad-json");
		const res = await runInDurableObject(s, (i: JobDO) =>
			i.fetch(
				new Request("http://do", {
					method: "POST",
					headers: { "X-Lampas-Job-Id": "bad-json" },
					body: "not json",
				}),
			),
		);
		expect(res.status).toBe(400);
	});
});
describe("status query", () => {
	it("returns job state", async () => {
		const s = stub("status-ok");
		await runInDurableObject(s, async (i: JobDO, st) => {
			await createJob(i, st, "status-ok");
			const res = await i.fetch(new Request("http://do", { method: "GET" }));
			expect(res.status).toBe(200);
			const body = (await res.json()) as AnyRec;
			expect(body.id).toBe("status-ok");
			expect(body.status).toBe("queued");
		});
	});

	it("returns 404 for unknown job", async () => {
		const s = stub("unknown");
		const res = await runInDurableObject(s, (i: JobDO) =>
			i.fetch(new Request("http://do", { method: "GET" })),
		);
		expect(res.status).toBe(404);
	});
});
describe("upstream execution", () => {
	it("calls upstream and wipes forward_headers", async () => {
		mockUpstream();
		mockCb();
		const s = stub("wipe");
		await runInDurableObject(s, async (i: JobDO, st) => {
			await createJob(i, st, "wipe");
			await i.alarm();
			expect(await st.storage.get("forward_headers")).toBeUndefined();
		});
	});

	it("stores upstream response", async () => {
		mockUpstream(200, { result: "ok" });
		mockCb();
		const s = stub("upstream-store");
		await runInDurableObject(s, async (i: JobDO, st) => {
			await createJob(i, st, "upstream-store");
			await i.alarm();
			const up = (await st.storage.get("upstream_response")) as AnyRec;
			expect(up).toBeDefined();
			expect(up.status).toBe(200);
		});
	});
});

describe("callback delivery", () => {
	it("delivers envelope and marks job completed", async () => {
		mockUpstream();
		mockCb();
		const s = stub("deliver-ok");
		await runInDurableObject(s, async (i: JobDO, st) => {
			await createJob(i, st, "deliver-ok");
			await i.alarm();
			expect(((await st.storage.get("job")) as AnyRec).status).toBe("completed");
			const cb = (await st.storage.get("cb:0")) as CallbackState;
			expect(cb.status).toBe("delivered");
			expect(cb.attempts).toBe(1);
		});
	});
});

describe("fan-out", () => {
	it("delivers to multiple callbacks", async () => {
		mockUpstream();
		mockCb();
		fetchMock
			.get("https://hook2.example.com")
			.intercept({ path: "/cb2", method: "POST" })
			.reply(200, "ok");
		const s = stub("fanout");
		const req = {
			...validReq,
			callbacks: [{ url: CB_URL }, { url: "https://hook2.example.com/cb2" }],
		};
		await runInDurableObject(s, async (i: JobDO, st) => {
			await createJob(i, st, "fanout", req);
			await i.alarm();
			expect(((await st.storage.get("job")) as AnyRec).status).toBe("completed");
			expect(((await st.storage.get("cb:0")) as CallbackState).status).toBe("delivered");
			expect(((await st.storage.get("cb:1")) as CallbackState).status).toBe("delivered");
		});
	});
});

describe("retry with alarm", () => {
	it("retries failed callback and succeeds", async () => {
		mockUpstream();
		mockCbFail();
		const s = stub("retry-ok");

		// First alarm: upstream ok, callback fails
		await runInDurableObject(s, async (i: JobDO, st) => {
			await createJob(i, st, "retry-ok");
			await i.alarm();
			const cb = (await st.storage.get("cb:0")) as CallbackState;
			expect(cb.status).toBe("pending");
			expect(cb.attempts).toBe(1);
			expect(((await st.storage.get("job")) as AnyRec).status).toBe("in_progress");
			await st.storage.deleteAlarm();
		});

		// Second alarm: callback succeeds
		mockCb();
		await runInDurableObject(s, async (i: JobDO, st) => {
			const cb = (await st.storage.get("cb:0")) as CallbackState;
			await st.storage.put("cb:0", { ...cb, next_retry_at: 0 });
			await i.alarm();
			expect(((await st.storage.get("cb:0")) as CallbackState).status).toBe("delivered");
			expect(((await st.storage.get("job")) as AnyRec).status).toBe("completed");
		});
	});
});

describe("retry exhaustion", () => {
	it("marks job failed when retries exhausted", async () => {
		mockUpstream();
		mockCbFail();
		const s = stub("exhaust");
		const req = { ...validReq, retry: { attempts: 2 } };

		// Attempt 1: fail
		await runInDurableObject(s, async (i: JobDO, st) => {
			await createJob(i, st, "exhaust", req);
			await i.alarm();
			expect(((await st.storage.get("cb:0")) as CallbackState).status).toBe("pending");
			await st.storage.deleteAlarm();
		});

		// Attempt 2: fail again — exhausted
		mockCbFail();
		await runInDurableObject(s, async (i: JobDO, st) => {
			const cb = (await st.storage.get("cb:0")) as CallbackState;
			await st.storage.put("cb:0", { ...cb, next_retry_at: 0 });
			await i.alarm();
			expect(((await st.storage.get("cb:0")) as CallbackState).status).toBe("failed");
			expect(((await st.storage.get("job")) as AnyRec).status).toBe("failed");
		});
	});
});

describe("HTTP method", () => {
	it("uses GET when method is GET and ignores body", async () => {
		mockUpstream(200, { result: "ok" }, "GET");
		mockCb();
		const s = stub("get-method");
		const req = { ...validReq, method: "GET" };
		await runInDurableObject(s, async (i: JobDO, st) => {
			await createJob(i, st, "get-method", req);
			await i.alarm();
			expect(((await st.storage.get("upstream_response")) as AnyRec).status).toBe(200);
			expect(((await st.storage.get("job")) as AnyRec).status).toBe("completed");
		});
	});

	it("defaults to POST when method is omitted", async () => {
		mockUpstream();
		mockCb();
		const s = stub("default-post");
		await runInDurableObject(s, async (i: JobDO, st) => {
			await createJob(i, st, "default-post");
			await i.alarm();
			expect(((await st.storage.get("upstream_response")) as AnyRec).status).toBe(200);
		});
	});
});

describe("upstream failure", () => {
	it("delivers failure envelope when upstream returns 500", async () => {
		mockUpstream(500, "Internal Server Error");
		mockCb();
		const s = stub("upstream-fail");
		await runInDurableObject(s, async (i: JobDO, st) => {
			await createJob(i, st, "upstream-fail");
			await i.alarm();
			expect(((await st.storage.get("upstream_response")) as AnyRec).status).toBe(500);
			expect(((await st.storage.get("job")) as AnyRec).status).toBe("completed");
		});
	});
});
