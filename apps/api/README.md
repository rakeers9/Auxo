# API

TypeScript/Fastify backend for Auxo's decision pipeline.

## Local development

From the repository root:

```bash
pnpm install
pnpm dev:api
```

The service listens on `http://127.0.0.1:3001` by default.

## Current endpoints

- `GET /health`
- `POST /v1/decide`

`/v1/decide` currently uses a deterministic stub. The last hexadecimal digit of
`cart_hash`, modulo four, selects L1 through L4. This lets extension developers
reproduce every overlay state before the Jev integration is available.

Use hashes ending in `0`, `1`, `2`, or `3` to request L1, L2, L3, or L4 while
testing. The other 63 characters must also be hexadecimal.

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
      "cart_hash": "0000000000000000000000000000000000000000000000000000000000000002"
    }
  }'
```

Example response:

```json
{
  "decision_id": "801bb931-9d32-5087-a658-b17f87e39c96",
  "lane": "L3",
  "action": "block",
  "template_id": "l3-block",
  "cooldown_seconds": 300
}
```

`.env.example` documents the supported environment variables. In production,
`CORS_ORIGINS` must contain at least one comma-separated extension origin.
