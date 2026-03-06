import type { RetryPolicy } from "./job";

/**
 * Tracks the current state of retry attempts for a callback delivery.
 */
export interface RetryState {
	/** Number of attempts made so far (0 = not yet attempted). */
	attempt: number;
	/** ISO 8601 timestamp of the next scheduled retry, or null if no more retries. */
	next_retry_at: string | null;
}

/**
 * Computes the backoff delay in milliseconds for a given attempt using exponential backoff.
 *
 * Formula: `min(initial_delay_ms * 2^attempt, max_delay_ms)`
 *
 * @param attempt - The zero-based attempt number
 * @param policy - The retry policy controlling backoff parameters
 * @returns Delay in milliseconds before the next retry
 */
export function computeBackoff(attempt: number, policy: RetryPolicy): number {
	const delay = policy.initial_delay_ms * 2 ** attempt;
	return Math.min(delay, policy.max_delay_ms);
}

/**
 * Determines whether another retry attempt should be made.
 *
 * Returns true if the current attempt number is less than the policy's maximum attempts.
 *
 * @param attempt - The zero-based attempt number (number of attempts already made)
 * @param policy - The retry policy controlling the maximum number of attempts
 * @returns Whether another attempt should be made
 */
export function shouldRetry(attempt: number, policy: RetryPolicy): boolean {
	return attempt < policy.attempts;
}
