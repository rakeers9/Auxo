# Extension

## Hosted backend connector

Production builds default to https://api-ten-sand-28.vercel.app. Override with
`WXT_API_BASE_URL=http://127.0.0.1:3001` when testing locally.

Open the extension's Options page, supply the Supabase project's **public**
publishable/anon key, and sign in with an existing email/password account.
The background worker stores and refreshes the session and attaches a bearer
token to decisions, events, and store configuration. Content scripts never
receive authentication tokens. Google OAuth remains a future sign-in option.

For real pause/block decisions, Continue requests a backend pass and verifies
it against the active-pass endpoint before unlocking clicks. Expired passes
block again. Dev-only synthetic verdicts retain their local test override.

Before hosted testing: deploy the merged API, apply the fresh-decision and
trigger/event migrations, and configure production CORS with the installed
extension ID. Install the build at `.output/chrome-mv3` in Chrome, then open
Options and sign in. Do not put service-role or Cloudflare secrets in the extension.

WXT browser extension (Chrome MV3 first, Amazon first). Owned by Person 1.

```bash
pnpm --filter @auxo/extension dev     # Chrome with the extension loaded
pnpm --filter @auxo/extension test
pnpm --filter @auxo/extension build   # .output/chrome-mv3
pnpm --filter @auxo/extension build:debug  # .output/chrome-mv3-dev, debug panel on
```

Run the API alongside it with `pnpm dev:api`. Set `WXT_API_BASE_URL` to point at another API.

Layout:

- `entrypoints/amazon.content.ts`: runs on Amazon, detects the cart, asks for a verdict, shows the overlay.
- `entrypoints/background.ts`: the only place that calls the API.
- `src/messages.ts`: types shared between the content script and the worker.
- `src/cart/`: page readers for Amazon product, cart, and checkout pages (`inspectAmazonPage`), price parsing, hashing.
- `src/clicks/`: classifies buy-intent clicks and submits (known Amazon buttons, generic guesses).
- `src/tracking/`: the click listener, the pending click/purchase store (sessionStorage), removal detection, and the tracker that decides when to ask the backend.
- `src/overlay/`: the shadow-DOM overlay for each lane.
- `src/api/`: the API client (timeout + fail-open).
- `src/debug/`: the dev-only debug panel. Dev builds (`dev`, `build:debug`) show it on every Amazon page with the page type, what was read, and the backend's answer, instead of the overlay. Production builds leave it out entirely.
