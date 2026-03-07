# Job Durable Object Design

Issue: #7 — Cloudflare: Job Durable Object

## Overview

The JobDO Durable Object owns the full lifecycle of a Lampas job: creation, upstream execution, envelope construction, callback delivery with retry, and status tracking. The Worker becomes a thin proxy that routes requests to the DO.

## Worker as Thin Proxy

The Worker generates a job ID, creates a DO stub by that ID, and forwards the request. It does not parse, validate, or persist anything — the DO handles all of that.

```
POST /forward
  Worker generates jobId (crypto.randomUUID())
  stub = env.JOB_DO.get(env.JOB_DO.idFromName(jobId))
  stub.fetch(request with jobId) -> returns 202 { job_id, status: "queued" }

GET /jobs/:id
  stub = env.JOB_DO.get(env.JOB_DO.idFromName(id))
  stub.fetch(GET) -> returns job state
```

The existing `handleRequest(request, jobStore)` function is removed. The Worker is a standard module export (`export default { fetch }`). The `@lampas/core` `JobStore` and `JobExecutor` interfaces (`backend.ts`) are deleted — they were premature abstraction that doesn't match the DO's fetch/alarm entry points.

## Respond First, Execute After

To minimize Worker billing (Worker + DO overlap is only the validation window):

1. DO receives POST, validates request, persists job state (status=`queued`)
2. DO returns 202 immediately
3. DO executes upstream call and callback delivery inside `ctx.waitUntil()`

## Storage Schema

| Key | Type | Written | Deleted |
|-----|------|---------|---------|
| `job` | `Job` | On creation | Never |
| `forward_headers` | `Record<string,string>` | On creation | After upstream call |
| `upstream_response` | `UpstreamResponse` | After upstream call | Never |
| `cb:0`, `cb:1`, ... | `CallbackState` | After upstream call | Never |

```ts
interface CallbackState {
  status: "pending" | "delivered" | "failed";
  attempts: number;
  next_retry_at: number | null; // epoch ms, null if terminal
}
```

Credential wiping: `forward_headers` are deleted from storage immediately after the upstream call completes, before any callback delivery.

## Lifecycle

1. Worker POST -> DO receives request
2. Validate via `RequestBodySchema`, persist `job` (queued) + `forward_headers`
3. Return 202 `{ job_id, status: "queued" }`
4. (via `ctx.waitUntil`): Update status to `in_progress`
5. Fetch upstream target with `forward_headers` + request body
6. Persist `upstream_response`, delete `forward_headers`
7. Build envelope via `buildEnvelope()`
8. Fan-out: attempt delivery to all callbacks in parallel
9. Store `cb:N` states
10. If all delivered -> status `completed`
11. If any need retry -> set alarm to earliest `next_retry_at`
12. If any exhausted retries and none still pending -> status `failed`

## Upstream Call Failure

If the upstream `fetch()` throws (network error, DNS failure):
- Store synthetic `UpstreamResponse` with status `0` and empty body
- Delete `forward_headers`
- Build envelope with `lampas_status: "failed"`
- Still deliver to all callbacks (caller wants to know it failed)

## Callback Delivery

- POST JSON envelope to callback URL
- Include callback-specific `headers` for correlation
- Success: HTTP 2xx response
- Failure: non-2xx, network error, or timeout
- On failure: increment attempts, compute backoff, store state

## Alarm Handler (Retries)

DOs support one alarm at a time. The alarm is set to the earliest `next_retry_at` across all pending callbacks.

1. Read all `cb:N` states
2. Filter to `status === "pending"` and `next_retry_at <= now`
3. Attempt delivery in parallel
4. Update states
5. If any still pending -> reschedule alarm to next earliest
6. Recompute job status

## Job Status Derivation

- `completed` = every `cb:N` is `delivered`
- `failed` = any `cb:N` is `failed` (exhausted retries) AND none still `pending`
- `in_progress` = otherwise

## Core Dependencies

The DO uses core's types, schemas, and utility functions:
- `RequestBodySchema` — request validation
- `Job`, `JobStatus`, `RequestBody`, `Callback`, `UpstreamResponse` — types
- `buildEnvelope()` — envelope construction
- `computeBackoff()`, `shouldRetry()` — retry scheduling

Core's `backend.ts` (JobStore/JobExecutor interfaces) is deleted.

## Testing

Tests use `@cloudflare/vitest-pool-workers` — runs inside the real Workers runtime with actual DO storage and alarms.

- `cloudflare/vitest.config.ts` using `defineWorkersConfig`
- `cloudflare/wrangler.toml` for DO bindings
- `fetchMock` from `cloudflare:test` to mock external HTTP (upstream + callbacks)

Test cases:
1. Job lifecycle: create -> upstream -> deliver -> completed
2. Successful delivery: callback receives correct envelope
3. Failed delivery with retry: alarm fires, retry succeeds
4. Fan-out: multiple callbacks all receive same envelope
5. Status query: GET returns correct state
6. Credential wiping: forward_headers absent after upstream call
7. Retry exhaustion: all retries fail -> job failed
8. Upstream failure: network error still delivers failure envelope

## File Changes

| File | Action |
|------|--------|
| `core/src/backend.ts` | Delete |
| `core/src/index.ts` | Remove backend.ts exports |
| `cloudflare/src/job-do.ts` | New — JobDO class |
| `cloudflare/src/job-do.test.ts` | New — DO tests |
| `cloudflare/src/worker.ts` | Rewrite — thin proxy |
| `cloudflare/src/worker.test.ts` | Rewrite — integration tests |
| `cloudflare/src/index.ts` | Update exports |
| `cloudflare/vitest.config.ts` | New — workers pool config |
| `cloudflare/wrangler.toml` | New — DO bindings |
| `cloudflare/package.json` | Add vitest-pool-workers dep |
