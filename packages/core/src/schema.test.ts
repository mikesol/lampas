import { describe, expect, it } from "vitest";
import { RequestBodySchema } from "./schema.js";

const validRequest = {
	target: "https://api.example.com/data",
	forward_headers: { Authorization: "Bearer tok_123" },
	callbacks: [{ url: "https://hook.example.com/callback" }],
	body: { key: "value" },
};

describe("RequestBodySchema", () => {
	it("accepts a valid request with all required fields", () => {
		const result = RequestBodySchema.parse(validRequest);
		expect(result.target).toBe(validRequest.target);
		expect(result.forward_headers).toEqual(validRequest.forward_headers);
		expect(result.callbacks).toEqual(validRequest.callbacks);
		expect(result.body).toEqual(validRequest.body);
		expect(result.retry).toBeUndefined();
	});

	it("applies retry defaults when retry is omitted", () => {
		const result = RequestBodySchema.parse({ ...validRequest, retry: {} });
		expect(result.retry).toEqual({
			attempts: 3,
			backoff: "exponential",
			initial_delay_ms: 1000,
		});
	});

	it("accepts a request with explicit retry policy", () => {
		const retry = { attempts: 5, backoff: "exponential" as const, initial_delay_ms: 2000 };
		const result = RequestBodySchema.parse({ ...validRequest, retry });
		expect(result.retry).toEqual(retry);
	});

	it("accepts a request with callback headers", () => {
		const callbacks = [
			{ url: "https://hook.example.com/cb", headers: { "X-Request-Id": "abc-123" } },
		];
		const result = RequestBodySchema.parse({ ...validRequest, callbacks });
		expect(result.callbacks[0].headers).toEqual({ "X-Request-Id": "abc-123" });
	});

	it("rejects when target is missing", () => {
		const { target: _, ...noTarget } = validRequest;
		const result = RequestBodySchema.safeParse(noTarget);
		expect(result.success).toBe(false);
	});

	it("rejects when target is not a valid URL", () => {
		const result = RequestBodySchema.safeParse({ ...validRequest, target: "not-a-url" });
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0].message).toBe("Target must be a valid URL");
		}
	});

	it("rejects when callbacks is an empty array", () => {
		const result = RequestBodySchema.safeParse({ ...validRequest, callbacks: [] });
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0].message).toBe("At least one callback is required");
		}
	});

	it("rejects when callbacks is missing", () => {
		const { callbacks: _, ...noCallbacks } = validRequest;
		const result = RequestBodySchema.safeParse(noCallbacks);
		expect(result.success).toBe(false);
	});

	it("rejects when a callback URL is invalid", () => {
		const result = RequestBodySchema.safeParse({
			...validRequest,
			callbacks: [{ url: "bad-url" }],
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0].message).toBe("Callback URL must be a valid URL");
		}
	});

	it("rejects when forward_headers is missing", () => {
		const { forward_headers: _, ...noHeaders } = validRequest;
		const result = RequestBodySchema.safeParse(noHeaders);
		expect(result.success).toBe(false);
	});

	it("accepts when body is undefined", () => {
		const { body: _, ...noBody } = validRequest;
		const result = RequestBodySchema.safeParse(noBody);
		expect(result.success).toBe(true);
	});

	it("accepts when body is null", () => {
		const result = RequestBodySchema.safeParse({ ...validRequest, body: null });
		expect(result.success).toBe(true);
	});
});
