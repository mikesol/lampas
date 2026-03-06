import { describe, expect, it } from "vitest";
import type { RetryPolicy } from "./job";
import { RetryPolicySchema } from "./job";
import { computeBackoff, shouldRetry } from "./retry";

const defaultPolicy: RetryPolicy = RetryPolicySchema.parse({});

describe("computeBackoff", () => {
	it("returns increasing delays for successive attempts", () => {
		const d0 = computeBackoff(0, defaultPolicy);
		const d1 = computeBackoff(1, defaultPolicy);
		const d2 = computeBackoff(2, defaultPolicy);

		expect(d0).toBeLessThan(d1);
		expect(d1).toBeLessThan(d2);
	});

	it("uses initial_delay_ms * 2^attempt formula", () => {
		const policy: RetryPolicy = RetryPolicySchema.parse({
			initial_delay_ms: 500,
		});
		expect(computeBackoff(0, policy)).toBe(500);
		expect(computeBackoff(1, policy)).toBe(1000);
		expect(computeBackoff(2, policy)).toBe(2000);
		expect(computeBackoff(3, policy)).toBe(4000);
	});

	it("never exceeds max_delay_ms", () => {
		const policy: RetryPolicy = RetryPolicySchema.parse({
			initial_delay_ms: 1000,
			max_delay_ms: 5000,
		});
		expect(computeBackoff(0, policy)).toBe(1000);
		expect(computeBackoff(1, policy)).toBe(2000);
		expect(computeBackoff(2, policy)).toBe(4000);
		expect(computeBackoff(3, policy)).toBe(5000);
		expect(computeBackoff(10, policy)).toBe(5000);
	});

	it("caps at default max_delay_ms of 30000", () => {
		expect(computeBackoff(100, defaultPolicy)).toBe(30000);
	});
});

describe("shouldRetry", () => {
	it("returns true when attempts remain", () => {
		const policy: RetryPolicy = RetryPolicySchema.parse({ attempts: 3 });
		expect(shouldRetry(0, policy)).toBe(true);
		expect(shouldRetry(1, policy)).toBe(true);
		expect(shouldRetry(2, policy)).toBe(true);
	});

	it("returns false when attempts are exhausted", () => {
		const policy: RetryPolicy = RetryPolicySchema.parse({ attempts: 3 });
		expect(shouldRetry(3, policy)).toBe(false);
		expect(shouldRetry(4, policy)).toBe(false);
	});

	it("works with single attempt", () => {
		const policy: RetryPolicy = RetryPolicySchema.parse({ attempts: 1 });
		expect(shouldRetry(0, policy)).toBe(true);
		expect(shouldRetry(1, policy)).toBe(false);
	});
});

describe("RetryPolicySchema defaults", () => {
	it("applies default values", () => {
		const policy = RetryPolicySchema.parse({});
		expect(policy.attempts).toBe(3);
		expect(policy.backoff).toBe("exponential");
		expect(policy.initial_delay_ms).toBe(1000);
		expect(policy.max_delay_ms).toBe(30000);
	});
});
