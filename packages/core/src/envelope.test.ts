import { describe, expect, it } from "vitest";
import { type UpstreamResponse, buildEnvelope } from "./envelope.js";

const JOB_ID = "job_abc123";
const TARGET = "https://api.example.com/data";
const DELIVERED_AT = "2026-01-15T12:00:00Z";

function makeUpstream(overrides?: Partial<UpstreamResponse>): UpstreamResponse {
	return {
		status: 200,
		headers: { "content-type": "application/json" },
		body: { result: "ok" },
		...overrides,
	};
}

describe("buildEnvelope", () => {
	it("wraps a successful upstream response", () => {
		const envelope = buildEnvelope(JOB_ID, TARGET, makeUpstream(), DELIVERED_AT);

		expect(envelope.lampas_job_id).toBe(JOB_ID);
		expect(envelope.lampas_status).toBe("completed");
		expect(envelope.lampas_target).toBe(TARGET);
		expect(envelope.lampas_delivered_at).toBe(DELIVERED_AT);
		expect(envelope.response_status).toBe(200);
		expect(envelope.response_headers).toEqual({ "content-type": "application/json" });
		expect(envelope.response_body).toEqual({ result: "ok" });
	});

	it("marks non-2xx upstream status as failed", () => {
		const envelope = buildEnvelope(
			JOB_ID,
			TARGET,
			makeUpstream({ status: 500, body: "Internal Server Error" }),
			DELIVERED_AT,
		);

		expect(envelope.lampas_status).toBe("failed");
		expect(envelope.response_status).toBe(500);
		expect(envelope.response_body).toBe("Internal Server Error");
	});

	it("marks 4xx upstream status as failed", () => {
		const envelope = buildEnvelope(JOB_ID, TARGET, makeUpstream({ status: 404 }), DELIVERED_AT);

		expect(envelope.lampas_status).toBe("failed");
		expect(envelope.response_status).toBe(404);
	});

	it("preserves binary/non-JSON body verbatim", () => {
		const binaryBody = new Uint8Array([0x00, 0xff, 0x42]);
		const envelope = buildEnvelope(
			JOB_ID,
			TARGET,
			makeUpstream({ body: binaryBody }),
			DELIVERED_AT,
		);

		expect(envelope.response_body).toBe(binaryBody);
	});

	it("preserves null body", () => {
		const envelope = buildEnvelope(JOB_ID, TARGET, makeUpstream({ body: null }), DELIVERED_AT);

		expect(envelope.response_body).toBeNull();
	});

	it("preserves undefined body", () => {
		const envelope = buildEnvelope(JOB_ID, TARGET, makeUpstream({ body: undefined }), DELIVERED_AT);

		expect(envelope.response_body).toBeUndefined();
	});

	it("produces deterministic key ordering", () => {
		const envelope = buildEnvelope(JOB_ID, TARGET, makeUpstream(), DELIVERED_AT);
		const keys = Object.keys(envelope);

		expect(keys).toEqual([
			"lampas_job_id",
			"lampas_status",
			"lampas_target",
			"lampas_delivered_at",
			"response_status",
			"response_headers",
			"response_body",
		]);
	});

	it("serializes deterministically via JSON.stringify", () => {
		const a = buildEnvelope(JOB_ID, TARGET, makeUpstream(), DELIVERED_AT);
		const b = buildEnvelope(JOB_ID, TARGET, makeUpstream(), DELIVERED_AT);

		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
	});
});
