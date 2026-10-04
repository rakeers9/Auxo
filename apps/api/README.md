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
- `GET /v1/rules`
- `POST /v1/rules`
- `PATCH /v1/rules/:id`
- `DELETE /v1/rules/:id`
- `GET /v1/budgets`
- `POST /v1/budgets`
- `PATCH /v1/budgets/:id`
- `DELETE /v1/budgets/:id`

`/v1/decide` now loads the authenticated user's enabled rules and active budget
before producing a verdict. The first policy engine supports:

- `cart_total`: `configuration` contains `threshold_minor` and `lane`
- `merchant`: `configuration` contains a `merchants` array and `lane`
- `item_keyword`: `configuration` contains a `keywords` array and `lane`

When multiple conditions match, the highest lane wins. An active same-currency
budget raises the verdict to L2 at 75% projected usage, L3 at 90%, and L4 when
the cart would exceed the limit. Unknown or malformed rule configurations are
ignored safely.

If the user has no rules or budgets, `/v1/decide` retains the deterministic
stub: the last hexadecimal digit of `cart_hash`, modulo five, selects L0 through
L4. This lets extension developers reproduce every overlay state before the Jev
integration is available.

Within the configured decision TTL, the same authenticated user, cart hash, and
policy configuration reuse the stored decision. Changing a rule or budget
automatically causes the cart to be evaluated again.

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

## Rules and budgets

All settings endpoints are scoped to the authenticated user. Attempts to update
or delete another user's setting return `404` without revealing that it exists.

Create a rule with `POST /v1/rules`:

```json
{
  "name": "Pause large purchases",
  "rule_type": "cart_total",
  "configuration": { "threshold_minor": 10000, "lane": "L2" },
  "enabled": true
}
```

`GET /v1/rules` returns `{ "rules": [...] }`. Use `PATCH /v1/rules/:id`
with one or more rule fields to change it, or `DELETE /v1/rules/:id` to remove
it.

Create a budget period with `POST /v1/budgets`:

```json
{
  "currency": "USD",
  "limit_minor": 50000,
  "period_start": "2026-10-01",
  "period_end": "2026-10-31"
}
```

Money is always represented in minor units. The backend initializes
`spent_minor` to zero; clients cannot directly overwrite it. `GET /v1/budgets`
returns `{ "budgets": [...] }`, and `PATCH /v1/budgets/:id` changes the limit.
