import type { Envelope } from "./envelope";
import type { UpstreamResponse } from "./envelope";
import type { Callback } from "./job";
import type { Job, JobStatus, RequestBody } from "./job";

/**
 * Persistence contract for Lampas jobs.
 *
 * Backend implementations provide durable storage for job state.
 * Core logic programs against this interface without knowledge of
 * the underlying storage mechanism.
 */
export interface JobStore {
	/** Create and persist a new job from a validated request. */
	createJob(request: RequestBody): Promise<Job>;

	/** Retrieve a job by its unique ID, or `null` if not found. */
	getJob(id: string): Promise<Job | null>;

	/** Transition a job to a new status. */
	updateJobStatus(id: string, status: JobStatus): Promise<void>;
}

/**
 * Execution contract for Lampas jobs.
 *
 * Backend implementations provide the HTTP machinery for calling
 * upstream APIs and delivering callback payloads. Each method
 * represents a single attempt — retry scheduling is the backend's
 * responsibility using core's retry logic.
 */
export interface JobExecutor {
	/** Call the target API and return the raw upstream response. */
	executeUpstreamCall(job: Job): Promise<UpstreamResponse>;

	/**
	 * Deliver an envelope to a single callback destination.
	 *
	 * @returns `true` if delivery succeeded, `false` otherwise.
	 */
	deliverCallback(job: Job, callback: Callback, envelope: Envelope): Promise<boolean>;
}
