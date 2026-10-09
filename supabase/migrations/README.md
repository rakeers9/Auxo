# Supabase migrations

Migrations are applied in filename order by the Supabase CLI.

The initial migration creates profiles, rules, budgets, merchants, extraction
recipes, decisions, events, purchase check-ins, and passes. User-owned tables
have row-level security policies, while backend-only decision writes use the
service-role client and never expose that credential to the extension.

Apply locally with:

```bash
supabase db reset
```

## Store config (`GET /v1/config`)

Store selector overrides are served from `merchants` and `recipes`; the API
reads them with the service-role client.

- `merchants.domain` is the exact hostname the extension sees (for example
  `www.amazon.com`, not `amazon.com`). It's lowercased when served.
  `merchants.enabled = false` turns the store off: it's sent as
  `{ "enabled": false }` whatever its recipes say.
- `recipes.selectors` holds the `StoreOverrides` shape minus `enabled`
  (`packages/shared/store-config.ts`):

  ```json
  {
    "buttons": { "add_to_cart": ["#add-to-cart-button"] },
    "selectors": { "<reader key>": "<css selector>" }
  }
  ```

  Both keys are optional. `buttons` is keyed by buy intent (`add_to_cart`,
  `buy_now`, `view_cart`, `checkout`, `place_order`).
- The merchant's highest `version` with `enabled = true` is served. Fix a
  store by inserting version N+1. Roll back by disabling it: the previous
  enabled version applies again.
- A recipe that fails validation is skipped and logged, and the store is sent
  with no overrides (the extension's bundled selectors). It never falls back to
  an older version.
- The response `version` is a sha256 of the served stores (`"default"` when
  there are none), so it changes exactly when the served content does.
