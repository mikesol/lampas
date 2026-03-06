# Lampas — Vision

## What Lampas Is

Lampas is a proxy that turns any API call into a webhook. You send a request to Lampas describing what to call and where to deliver the response. Lampas makes the call, and when a response arrives, delivers it to the callback URLs you specified. The original caller is free to exit immediately.

The motivating observation: HTTP's request-response model assumes the caller persists for the duration of the call. In an ephemeral compute world — serverless functions, disposable VMs, agents that spin up and dissolve — this assumption is broken. Lampas corrects it without requiring the target API to change anything.

## What Lampas Is Not

Lampas is not a message queue. It does not implement pub/sub, manage topics and subscriptions, or broker messages between multiple producers and consumers. What it *does* store is job state — the in-flight request, retry history, and response — scoped to the lifetime of a single job. Results are retained for a configurable period (specified by the caller, up to a platform maximum) and queryable by job ID. This means polling is a first-class pattern alongside callbacks: fire a request, get a job ID, fetch the result whenever you're ready. The webhook and the poll are two views of the same underlying mechanism; neither is special.

Lampas is not a secrets manager. It never stores credentials. API keys and auth headers are supplied per-request and are never persisted beyond the lifetime of a job.

Lampas is not a workflow engine. It does not chain calls, branch on results, or model multi-step processes. One request in, one (or more) callbacks out.

## The Request as Execution Plan

The central design principle of Lampas is that **a request contains its own complete execution specification**. There is no control plane to configure, no pre-registered webhooks, no dashboard. The request arrives carrying everything needed to route its response: the target URL, the callback destinations, the retry policy, and the forwarded credentials.

This is inspired by continuation-passing style: the "what to do next" is passed along with the work itself, not stored separately. It makes Lampas stateless from the caller's perspective and composable by construction — any HTTP client can speak the protocol without SDK or setup.

## Core Concepts

**Job** — the unit of work. Created when a request arrives. Has a unique ID, a status (`queued`, `in_progress`, `completed`, `failed`), and an immutable record of the original request.

**Target** — the upstream API being called. Lampas forwards the request body and specified headers faithfully, adding nothing.

**Callback** — a destination for the response. Each callback has a URL and a protocol. Phase 0 supports `https://` only. Callbacks is an array: multiple entries mean fan-out, the same response delivered to each destination.

**Retry** — the policy applied when a callback delivery fails. The receiver may be temporarily down, may not exist yet, or may have been recycled. Retry with configurable attempts and exponential backoff is not optional behavior — it is the default.

**Envelope** — the wrapper Lampas adds around the upstream response when delivering to a callback. Contains the job ID, delivery timestamp, original target, and the upstream response (status, headers, body) verbatim. Correlation IDs can be injected as custom callback headers.

## Principles

These principles are the reference for design alignment in PRs. Deviations require a `spec-change` issue.

**1. The request is the spec.**
All execution behavior — target, callbacks, retry policy, forwarded credentials — is specified in the request body. Nothing is configured out-of-band. A Lampas deployment has no per-user state, no registered endpoints, no stored configuration.

**2. Credentials are never stored.**
API keys and auth headers are supplied by the caller in the request body, forwarded to the target during job execution, and then discarded. Lampas holds credentials only for the duration of an in-flight request. No credential ever touches durable storage.

**3. The upstream response is preserved verbatim.**
Lampas does not parse, transform, or interpret the upstream response body. It wraps it in an envelope and delivers it. If the upstream returns a 500 with a malformed JSON body, that is exactly what the callback receives.

**4. Callbacks are best-effort with bounded retry.**
Lampas attempts delivery according to the retry policy specified in the request. If all attempts are exhausted, the job is marked `failed` and the failure is recorded. Lampas does not implement a dead-letter queue in Phase 0. Reliability beyond the retry window is the caller's responsibility.

**5. Fan-out is structural, not special.**
Multiple callbacks are not a premium feature or a separate code path. The callbacks field is always an array. Delivering to one callback and delivering to ten are the same operation at different cardinalities.

**6. The core defines the backend contract.**
The `core` package defines primitives — job schema, envelope format, retry logic — and the type contracts that backends must satisfy. Backend implementations (Cloudflare, and others in future) depend on core and implement its interfaces; core does not depend on backends. This is the standard inversion: backends are plugins to a stable contract, not forks of a shared implementation.

**7. Phase 0 backend is Cloudflare Workers + Durable Objects.**
A Durable Object owns the lifecycle of each job: it accepts the request, stores job state, executes the upstream call, manages retry, and delivers the callback. Workers serve as the stateless entry point. This is the only supported backend in Phase 0.

## Package Structure

```
lampas/
  packages/
    core/        # Job schema, envelope, retry logic, backend interface contracts
    cloudflare/  # Implements core backend contracts via Durable Objects + Workers
```

Additional backends (AWS Lambda + SQS, self-hosted Node, etc.) are out of scope for Phase 0 but are the reason `core` exists as a separate package.

## What Phase 0 Delivers

- A deployable Cloudflare Worker that accepts Lampas requests
- `https://` callback delivery with configurable retry and exponential backoff
- Job status queryable by ID
- An envelope format that is stable enough to build against
- A public PoC at `lampas.dev` running the reference deployment
- The open-source repo at `github.com/mikesol/lampas`

## What Phase 0 Does Not Deliver

- Additional callback protocols (`sqs://`, `queue://`, `postgres://`, etc.)
- Stored credentials or API key management
- A dead-letter queue
- Authentication on the Lampas endpoint itself
- SDKs or client libraries
- A dashboard or observability UI

## The Name

Lampas (Λαμπάς) is the ancient Greek torch race — the Lampadedromia — in which runners posted at intervals passed a lit torch down the line, each sprinting at full speed before handing off to the next. The winner was the first team to carry the torch across the finish line with it still burning. If the flame went out, the team lost.

The metaphor is exact. Lampas the software carries a response from the moment the caller dissolves to the moment the callback receives it, across a gap where HTTP usually demands someone stand and wait. The torch must arrive lit. The original runner need not survive the race.