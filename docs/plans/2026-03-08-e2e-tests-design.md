# E2E Test Suite Design (Issue #8)

## Overview

True end-to-end tests for Lampas: real HTTP calls flow through a live `wrangler dev` worker, hit a real mock upstream server, and deliver webhooks to a real mock callback server. All on localhost, no mocking of HTTP at any level.

## Architecture

```
Test Suite (Vitest, Node pool)
  |
  |-- POST /forward ---------> wrangler dev (localhost:8787)
  |-- GET /jobs/:id ---------->    Worker -> JobDO
  |                                   |
  |   Mock Upstream (port 9001) <-----| fetch (upstream call)
  |     returns configurable response |
  |                                   |
  |   Mock Callback (port 9002) <-----| POST envelope (webhook delivery)
  |     captures requests, resolves promises
```

## Components

### Wrangler dev subprocess
- Spawned in `beforeAll` via `wrangler dev --port 8787`
- Readiness check: poll until the server responds
- Killed in `afterAll`

### Mock upstream server
- `http.createServer` on port 9001
- Configurable handler per test (default: 200 JSON `{"result":"ok"}`)
- Handler reset between tests

### Mock callback server
- `http.createServer` on port 9002
- Captures received POSTs keyed by path
- `waitForRequest(path, timeoutMs)` returns a promise that resolves when a POST arrives on that path
- Default response: 200. Configurable per test (e.g., return 500 for first N calls)
- Fan-out uses different paths on the same server (`/hook1`, `/hook2`, `/hook3`)

### Test helper: `lampas(path, options?)`
- Thin wrapper: `fetch("http://localhost:8787" + path, options)`

## File Structure

```
packages/cloudflare/
  vitest.e2e.config.ts          # Node pool, includes only e2e/*.test.ts
  src/e2e/
    helpers.ts                  # Mock servers, wrangler lifecycle, utilities
    e2e.test.ts                 # All 7 test scenarios
```

## Test Scenarios

| # | Scenario | Flow | Key Assertions |
|---|----------|------|----------------|
| 1 | Happy path | POST /forward -> upstream 200 JSON -> callback receives envelope | Envelope has correct `lampas_job_id`, `response_status: 200`, `response_body`. GET /jobs/:id returns `completed`. |
| 2 | Callback retry | Callback returns 500 first, then 200 | Callback receives exactly 2 POSTs. Job `completed`. |
| 3 | Callback failure | Callback always returns 500 | Retries exhausted. GET /jobs/:id returns `failed`. |
| 4 | Fan-out | 3 callbacks on different paths | All 3 paths receive the same envelope. Job `completed`. |
| 5 | Validation errors | Malformed JSON, missing target, invalid URL | 400 response. No upstream/callback calls. |
| 6 | Job status query | GET /jobs/:id at various points | Correct status. 404 for nonexistent job. |
| 7 | Verbatim response | Upstream returns plain text | Envelope `response_body` is the exact string, not parsed. |

## Async Handling

- Primary: await `waitForRequest()` on the mock callback server (promise resolves on receipt)
- Secondary: confirm via `GET /jobs/:id` after callback receipt
- Timeout: 10s default for `waitForRequest` (alarms + retries need time)
- Retry scenarios use short custom delays: `{ attempts: N, initial_delay_ms: 100, max_delay_ms: 200 }`

## Configuration

- `vitest.e2e.config.ts`: standard Node pool (not workers pool), includes `src/e2e/**/*.test.ts`
- `packages/cloudflare/package.json`: new script `test:e2e` runs `vitest run --config vitest.e2e.config.ts`
- Root `package.json`: `npm run test` wired to include E2E tests

## Design Principles Validated

1. **Request is the spec**: E2E tests send complete request bodies with target, callbacks, retry config
2. **Credentials never stored**: Happy path test can verify forward_headers reach upstream but not persisted (via GET /jobs/:id response)
3. **Upstream response preserved verbatim**: Verbatim scenario verifies plain text body passes through unchanged
4. **Callbacks best-effort with bounded retry**: Retry and failure scenarios exercise this directly
5. **Fan-out is structural**: 3-callback scenario
6. **Core defines backend contract**: Tests exercise the real core+cloudflare integration
7. **Phase 0 = Cloudflare**: Tests run against the actual Cloudflare backend via wrangler dev
