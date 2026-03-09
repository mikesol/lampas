// @lampas/core — Job schema, envelope, retry logic

export {
	type Envelope,
	EnvelopeSchema,
	type UpstreamResponse,
	buildEnvelope,
} from "./envelope";

export {
	type Callback,
	CallbackSchema,
	type HttpMethod,
	HttpMethodSchema,
	type Job,
	JobSchema,
	type JobStatus,
	JobStatusSchema,
	type RequestBody,
	type RequestBodyInput,
	RequestBodySchema,
	type RetryPolicy,
	type RetryPolicyInput,
	RetryPolicySchema,
} from "./job";

export { type RetryState, computeBackoff, shouldRetry } from "./retry";

export {
	BLOCKED_CIDRS,
	type CidrRange,
	type SsrfPolicy,
	type SsrfResult,
	ipInCidr,
	parseCidr,
	parseIp,
	parseIpv4,
	parseIpv6,
	parseSsrfPolicy,
	validateIp,
	validateUrl,
} from "./ssrf";
