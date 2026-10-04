# API

TypeScript/Fastify backend for Auxo's decision pipeline.

## Local development

From the repository root:

```bash
pnpm install
pnpm dev:api
```

The service listens on `http://127.0.0.1:3001` by default.

With the default `AUTH_MODE=development`, requests without a bearer token use
a fixed development user and decisions are held in memory. This keeps the
extension integration unblocked before Supabase credentials are available.

To enable authenticated persistence, configure all three Supabase variables in
`.env.example` and set `AUTH_MODE=required`. The extension must then send its
Supabase access token:

```http
Authorization: Bearer <supabase-access-token>
```

The service validates the token with Supabase Auth and uses only the resulting
user ID. The service-role key remains server-side and is used by the decision
repository; it must never be included in extension code.

## Current endpoints

- `GET /health`
- `POST /v1/decide`
- `POST /v1/events`
- `POST /v1/check-ins`

`/v1/decide` currently uses a deterministic stub. The last hexadecimal digit of
`cart_hash`, modulo five, selects L0 through L4. This lets extension developers
reproduce every overlay state before the Jev integration is available.

Within the configured decision TTL, the same authenticated user and cart hash
reuse the stored decision instead of generating a second record.

Use hashes ending in `0`, `1`, `2`, `3`, or `4` to request L0, L1, L2, L3, or
L4 while testing. The other 63 characters must also be hexadecimal.

Example request:

```bash
curl -X POST http://127.0.0.1:3001/v1/decide \
  -H "content-type: application/json" \
  -d '{
    "cart": {
      "merchant": "Example Store",
      "items": [{ "name": "Example item", "price_minor": 2500, "qty": 1 }],
      "total_minor": 2500,
      "currency": "USD",
      "url": "https://example.com/cart",
      "cart_hash": "0000000000000000000000000000000000000000000000000000000000000003"
    }
  }'
```

Example response:

```json
{
  "decision_id": "2b9ebefe-78c8-561e-9a68-da51842c65a8",
  "lane": "L3",
  "action": "block",
  "template_id": "l3-block",
  "cooldown_seconds": 300
}
```

`.env.example` documents the supported environment variables. In production,
`CORS_ORIGINS` must contain at least one comma-separated extension origin,
authentication must be required, and all Supabase credentials must be present.

## Recording outcomes

The extension records what happened after a verdict with `POST /v1/events`:

```json
{
  "event_id": "a508f723-41f4-44c1-92cc-bf357581cd3a",
  "decision_id": "2b9ebefe-78c8-561e-9a68-da51842c65a8",
  "action": "saved",
  "occurred_at": "2026-10-04T16:00:00.000Z",
  "metadata": { "source": "overlay" }
}
```

Delayed purchase feedback is sent to `POST /v1/check-ins`:

```json
{
  "decision_id": "2b9ebefe-78c8-561e-9a68-da51842c65a8",
  "worth_it": "yes",
  "note": "Used it immediately.",
  "answered_at": "2026-10-04T17:00:00.000Z"
}
```

Both endpoints verify that the decision belongs to the authenticated user.
First submissions return `201`; idempotent retries return `200` with
`duplicate: true`.
