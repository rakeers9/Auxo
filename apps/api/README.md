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
- `POST /v1/passes`
- `GET /v1/passes/active?cart_hash=...`
- `GET /v1/config`
- `GET /v1/rules`
- `POST /v1/rules`
- `PATCH /v1/rules/:id`
- `DELETE /v1/rules/:id`
- `GET /v1/budgets`
- `POST /v1/budgets`
- `PATCH /v1/budgets/:id`
- `DELETE /v1/budgets/:id`

`/v1/decide` now loads the authenticated user's enabled rules and active budget
before producing a verdict. Each rule has a `rule_type` and a `configuration`
whose shape depends on the type (`RuleConfigurationSchemas` in
`packages/shared/rules.ts`); `lane` is the lane the rule asks for when it matches:

- `cart_total`: `{ "lane", "threshold_minor" }`, matches when the cart total is at
  least `threshold_minor`
- `merchant`: `{ "lane", "merchants": [...] }` (1-100 non-empty strings)
- `item_keyword`: `{ "lane", "keywords": [...] }` (1-100 non-empty strings)

`POST /v1/rules` rejects a configuration that doesn't fit its `rule_type`.

When multiple conditions match, the highest lane wins. An active same-currency
budget raises the verdict to L2 at 75% projected usage, L3 at 90%, and L4 when
the cart would exceed the limit. Unknown or malformed rule configurations are
ignored safely.

If the user has no rules or budgets, `/v1/decide` retains the deterministic
stub: the last hexadecimal digit of `cart_hash`, modulo five, selects L0 through
L4. This lets extension developers reproduce every overlay state before the
Cloudflare Clef integration is configured.

## Cloudflare Clef decision signal

Set both `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` to enable Clef on
Workers AI. The API sends the cart, enabled rules, budgets, and deterministic
policy lane to one typed choice question. Clef returns L0 through L4 with
probabilities and confidence; Auxo always selects the stricter of Clef and the
deterministic policy, so the model cannot weaken a hard rule or budget block.

The Clef request has a configurable short timeout (`DECISION_MODEL_TIMEOUT_MS`,
2000 ms by default), no automatic retries, and never exposes the token to the
extension. Timeouts, provider errors, and invalid responses fall back to the
deterministic engine. The selected model and structured output are stored with
the decision for later evaluation.

`CLEF_MODEL` accepts `clef` (the default precision model) or `clef-flash` (the
lower-latency model).

## Checkout passes and safeguards

For pause or block verdicts, `POST /v1/passes` accepts a `decision_id` after
the verdict cooldown has elapsed. It returns a short-lived, user-scoped pass
for that exact cart hash and merchant. The extension can query
`GET /v1/passes/active?cart_hash=...` before lifting checkout blocking. Passes
are idempotent per decision and default to a ten-minute lifetime.

The API limits request bodies to 64 KiB and event `metadata` to 16 KiB of JSON
(UTF-8), and applies a configurable fixed-window rate limit (`RATE_LIMIT_MAX`
requests per `RATE_LIMIT_WINDOW_MS`, 120 per minute by default; `/health` is
exempt). Requests with a valid bearer token are counted per user; everything
else is counted per client IP. Limited requests get `429 RATE_LIMITED` with a
`retry-after` header. Counts live in memory (`InMemoryRateLimitStore` in
`src/rate-limit.ts`), so each serverless instance limits on its own; a shared
store can be dropped in behind the `RateLimitStore` interface later.
`PASS_TTL_SECONDS` sets the pass lifetime.

Behind a proxy, set `TRUST_PROXY=true` so the client IP is read from
`X-Forwarded-For`. **The Vercel deployment needs `TRUST_PROXY=true`**: without it
every request appears to come from Vercel's proxy and all signed-out callers
share one IP bucket. Leave it `false` (the default) when the API is reached
directly, or clients can spoof their IP with the header.

Run `pnpm eval:policy` from the repository root to evaluate the deterministic
policy against 100 labeled synthetic carts. The command reports accuracy and a
lane confusion matrix and fails when accuracy drops below 95%.

Every request is evaluated fresh and stored as its own decision with a new
random `decision_id`. Stored decisions are never reused, so the same cart can
get a different answer as rules, budgets, history, or the model's view change.

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

The request may also carry an optional `trigger` (`packages/shared/trigger.ts`)
saying which buy-intent click or page load caused it.

Example response (stub, no rules or budgets; `decision_id` is a random UUID):

```json
{
  "decision_id": "f3fd08e7-ca69-4dee-a04d-82f16a90994e",
  "lane": "L3",
  "action": "block",
  "template_id": "l3-block",
  "cooldown_seconds": 300,
  "context": {
    "decision_id": "f3fd08e7-ca69-4dee-a04d-82f16a90994e",
    "cart_summary": { "merchant": "Example Store", "total_minor": 2500, "currency": "USD", "item_count": 1 },
    "budget": null,
    "matched_rules": [],
    "model_signal": null,
    "decisive_factors": [{ "code": "no_policy_match", "source": "policy", "lane": "L0" }],
    "available_actions": ["leave", "save_for_later", "override_after_cooldown"]
  }
}
```

`context` (`packages/shared/decision-context.ts`) explains the decision: the
budget projection, matched rules, the Clef signal, the decisive factors, and
the actions the overlay may offer.

`.env.example` documents the supported environment variables. In production,
`CORS_ORIGINS` must contain at least one comma-separated extension origin,
authentication must be required, and all Supabase credentials must be present.

## Recording outcomes

The extension records what happened after a verdict with `POST /v1/events`:

```json
{
  "event_id": "a508f723-41f4-44c1-92cc-bf357581cd3a",
  "decision_id": "f3fd08e7-ca69-4dee-a04d-82f16a90994e",
  "action": "saved",
  "occurred_at": "2026-10-04T16:00:00.000Z",
  "metadata": { "source": "overlay" }
}
```

`action` is one of `left`, `saved`, `overrode`, `removed`, or `bought`.
`metadata` is optional JSON, at most 16 KiB when serialized.

Delayed purchase feedback is sent to `POST /v1/check-ins`:

```json
{
  "decision_id": "f3fd08e7-ca69-4dee-a04d-82f16a90994e",
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
with one or more of `name`, `configuration`, and `enabled` to change it, or
`DELETE /v1/rules/:id` to remove it. A rule's `rule_type` can't be changed
(create a new rule instead), and a new `configuration` must fit the stored
type. Invalid requests return `400 INVALID_REQUEST` with zod's flattened
`details` (`formErrors` and `fieldErrors`), on every create and update route.

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

## Store config

`GET /v1/config` (authenticated like the other routes, the same for every user)
returns the store selector overrides and per-store on/off switches from the
`merchants` and `recipes` tables, as a `StoreConfig`
(`packages/shared/store-config.ts`):

```json
{ "version": "default", "stores": {} }
```

`stores` is keyed by lowercase hostname (e.g. `www.amazon.com`), and each
entry is `{ "enabled", "buttons"?, "selectors"? }` from the store's latest
enabled recipe. `version` changes whenever any store's overrides change.
Rows or recipes that fail validation are skipped and logged rather than
breaking the response.

Pass lifecycle, budget spend tracking, and trigger-aware decisions are being
reworked on parallel branches; this README describes this branch.
