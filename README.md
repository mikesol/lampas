# Lampas

Turn any API into a webhook. Send a request to Lampas specifying a target API, callback URLs, and a retry policy. Lampas makes the upstream call and delivers the response to your callbacks. Your caller can exit immediately.

## How it works

Lampas acts as a proxy: you POST a job describing what to call and where to deliver the result. Lampas calls the target, wraps the response in an envelope with metadata, and POSTs it to each callback URL with exponential backoff on failure.

## Quick start

```bash
curl https://lampas.dev/forward \
  -H "content-type: application/json" \
  -d '{
    "target": "https://api.anthropic.com/v1/messages",
    "forward_headers": {
      "x-api-key": "$ANTHROPIC_API_KEY",
      "anthropic-version": "2023-06-01"
    },
    "callbacks": [
      { "url": "https://your-webhook.example.com" }
    ],
    "retry": { "attempts": 3, "backoff": "exponential" },
    "body": {
      "model": "claude-opus-4-5",
      "max_tokens": 1024,
      "messages": [{"role": "user", "content": "Hello."}]
    }
  }'
```

Lampas returns a job ID immediately:

```json
{ "job_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }
```

Check job status:

```bash
curl https://lampas.dev/jobs/<job_id>
```

Your callback receives an envelope like:

```json
{
  "lampas_job_id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  "lampas_status": "completed",
  "lampas_target": "https://api.anthropic.com/v1/messages",
  "lampas_delivered_at": "2026-03-06T08:31:00Z",
  "response_status": 200,
  "response_headers": { "content-type": "application/json" },
  "response_body": { "..." : "..." }
}
```

## Project structure

```
packages/
  core/        — Shared types, schemas (Zod), and retry logic
  cloudflare/  — Cloudflare Worker + Durable Object implementation
```

## Development

```bash
pnpm install
pnpm run build
pnpm run check
pnpm run test
```

### Local dev server

```bash
cd packages/cloudflare
pnpm exec wrangler dev
```

## Deploy

Lampas deploys to Cloudflare Workers with Durable Objects.

### Automatic (CI)

Pushes to `main` trigger the deploy workflow. Requires a `CLOUDFLARE_API_TOKEN` secret in GitHub.

### Manual

```bash
cd packages/cloudflare
pnpm deploy:production
```

This deploys to the production environment with the `lampas.dev` route.

## Architecture

See [VISION.md](VISION.md) for design principles and [ARTICLE.md](ARTICLE.md) for the motivation behind the project.

## License

MIT
