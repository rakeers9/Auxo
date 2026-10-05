# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Working rules (non-negotiable)

- **Linear is the source of truth.** Every decision and every bit of progress (branch pushed, endpoint working, contract changed, question resolved) gets written to Linear in the same session. If code and Linear disagree, fix one of them and say which.
- **Backend changes also update their Linear issue** (from `.cursor/rules/backend-linear-sync.mdc`, applies to `apps/api`, `packages/shared`, `supabase`, `evals`). After implementing and verifying, update the matching issue in the Auxo team with: what behavior changed, the area, the commit or PR link, which tests/typecheck/build ran, and remaining work or blockers. Keep its status accurate. **Ask before creating an issue** if none fits. If Linear is unavailable, say the update is pending; never skip it silently.
- **Never assume. Ground everything in code.** Read the relevant files before deciding, proposing, or stating anything about the codebase. Check the actual branch state (`git fetch`, `git log --all`) before describing what exists, since both developers push in parallel. If something can't be verified, say so instead of guessing. This includes third-party pages (e.g. Amazon's DOM) and library APIs: check a real fixture or the installed package, never write selectors or API calls from memory.
- **Every change ships with tests.** New code gets unit tests in the same commit (colocated `*.test.ts`). DOM code (cart extraction, overlay) is tested against HTML fixtures with happy-dom. A bug fix gets a test that failed before the fix.
- **The full suite stays green.** Before every commit run `pnpm test && pnpm typecheck && pnpm build` from the repo root, all must pass. Never commit with a failing or skipped test, and never delete or weaken a test to make it pass. Report the actual pass/fail counts.
- **Update Linear at the end of every piece of work.** When a task is done and verified, update its Linear issue (what changed, files, commit hash, test counts, what's left) and add a dated progress line to "Build Plan & Decisions". New decisions go in its decisions log. If Linear is unavailable, say the update is pending; never skip it silently.

## Working with multiple Claude sessions

Several Claude Code sessions may build in parallel. Rules:

- **One worktree per session.** Extra sessions work in `.claude/worktrees/<name>` on their own branch. Never edit files in another session's worktree.
- **Claim files before editing.** Each session owns the directories it was assigned and touches nothing else. To change something outside your scope, message the owning session first.
- **Contracts and dependencies are shared.** Announce any change to `packages/shared`, root config, or `package.json`/`pnpm-lock.yaml` to all sessions before making it. Only the coordinating (main) session adds dependencies, so the lockfile doesn't conflict.
- **Integration branch.** Extension work branches from `extension` and is merged back into `extension` by the coordinating session after the suite passes. Rebase on `extension` before handing work back.
- **Report back when done:** branch, commit hash, files changed, test counts.

## Linear

Everything lives under the Linear **team** "Auxo" (workspace `personal-trainer-crm`). It is not a Linear project, so `list_projects` returns nothing. Use `list_documents` filtered to the Auxo team.

- **Build Plan & Decisions:** phases, dated decisions log, open questions. Wins when docs disagree. Append new decisions and progress here.
- **Initial Design Doc:** the product (lanes, Jev, surfaces, feedback loop, §14 open source).
- **2-person split:** ownership. Person 1 (Sreekar) owns `apps/extension`, including cart detection and extraction. Person 2 (Aarav) owns `apps/api`, Supabase, Jev, and the policy engine.

## Commands

pnpm workspace (`apps/*`, `packages/*`), Node >= 20. `main` was fast-forwarded to `backend` on 2026-10-04.

```bash
pnpm install
pnpm test                 # all packages
pnpm typecheck
pnpm build
pnpm dev:api              # API on http://127.0.0.1:3001 with tsx watch

# single test file / single test (build shared first, see below)
pnpm --filter @auxo/shared build
pnpm --filter @auxo/api exec vitest run src/app.test.ts -t "rejects an invalid cart"

# local database (Supabase CLI, needs Docker running)
supabase db start         # local Postgres on 127.0.0.1:54322, applies supabase/migrations
supabase db reset         # wipe and re-apply all migrations
supabase stop

# extension (WXT, Chrome MV3)
pnpm --filter @auxo/extension dev        # opens Chrome with the extension loaded
pnpm --filter @auxo/extension build      # output in apps/extension/.output/chrome-mv3
pnpm --filter @auxo/extension build:debug  # .output/chrome-mv3-dev: always-on debug panel, no overlay
pnpm --filter @auxo/extension test
pnpm --filter @auxo/extension exec vitest run src/cart
```

**`@auxo/shared` resolves to its compiled `dist/`,** not its `.ts` sources. The `apps/api` scripts build it first. Calling `vitest` or `tsc` directly after changing `packages/shared`, or on a fresh clone, fails with `Failed to resolve entry for package "@auxo/shared"` until you run `pnpm --filter @auxo/shared build`.

## Architecture

Auxo adds friction before impulse purchases. The pipeline spans both apps:

1. **Extension content script** (`apps/extension`, WXT, Chrome first, Amazon first). Buy-intent clicks (add to cart, buy now, go to cart, checkout, place order; `src/clicks`) decide *when* to ask, and the page readers (`src/cart`, `inspectAmazonPage`) decide *what* to send. Cart and checkout pages are also asked about on load. Every request sends the `Cart` plus a `Trigger` (`packages/shared/trigger.ts`). A click that changes pages is remembered in sessionStorage for the next page (`src/tracking`). Items removed after a decision send a `removed` event, and a place-order click is held for the order confirmation page to send `bought`.
2. **`POST /v1/decide`** validates the cart and returns a `Verdict` (lane, action, template_id, cooldown_seconds). The real version builds state (budget, rules, history), asks Jev for signals, and runs a deterministic policy engine. **Jev only supplies signals; code makes the final call.**
3. The extension broadcasts the verdict as an internal `verdict` message. The overlay (shadow DOM) renders the lane. L3/L4 checkout blocking uses `declarativeNetRequest` and is lifted by a `Pass`.
4. User exits (`left`, `saved`, `overrode`, `bought`) go back as events, and later a "was it worth it?" check-in feeds regret rates into future decisions.

Invariants from the design doc: users can always continue (after a cooldown), every override is logged, and any timeout or error **fails open** (about 2 seconds).

`/v1/decide` (`apps/api/src/services/decision-service.ts`) runs the policy engine (`policy-engine.ts`) when the user has rules or budgets, takes the stricter of that and the decision model's lane when `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` are set (Cloudflare Clef, `decision-model-provider.ts`; replaced Jev/TypeSafe on 2026-10-04, AUX-9), and otherwise falls back to the stub (`stub-decision.ts`). The response also carries an optional `context` (`packages/shared/decision-context.ts`) explaining the decision. `/v1/passes` issues a pass for a decision. Every request is analyzed fresh and gets its own random `decision_id`; past verdicts are never reused (decided 2026-10-04). In the stub, the last hex digit of `cart_hash` mod 5 picks L0–L4. With no rules and no model key, use a 64-hex `cart_hash` ending in `0`–`4` to get each lane in the extension.

## Contracts (`packages/shared`)

- The contracts are the handoff between extension and API. Change them here first, before either side depends on the change.
- Each contract is a zod schema with `.strict()`, and the TypeScript type comes from `z.infer`. The API validates every request body with `safeParse` and returns 400 `INVALID_REQUEST` on failure.
- Money is integer minor units (`price_minor`, `total_minor`). Never use decimals for money.
- `Lane` is L0–L4. L0 is a silent pass that is still returned and logged. `Record<Lane, …>` tables must cover all five.
- IDs are UUIDs. `cart_hash` is 64 hex chars with an optional `sha256:` prefix.
- API errors always look like `{ error: { code, message, details? } }`.

## Conventions

- ESM with `module: NodeNext` in `apps/api` and `packages/shared`: relative imports must end in `.js` (e.g. `import { buildApp } from "./app.js"`), even in `.ts` files.
- `tsconfig.base.json` enables `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. Indexed reads may be `undefined`, and optional props can't be assigned `undefined` explicitly.
- Extension: WXT 0.21 with auto-imports off (`imports: false`), so import `defineContentScript`, `browser`, etc. explicitly from `wxt/...`. It uses WXT's generated tsconfig (bundler resolution), so its relative imports have **no** `.js` suffix, unlike `apps/api`. Tests run in vitest with happy-dom and WXT's fake browser. API calls go through the background worker (`entrypoints/background.ts`), never from the page, so CORS only has to allow the extension origin. Shared extension types live in `apps/extension/src/messages.ts`. The API base URL comes from `WXT_API_BASE_URL` (default `http://127.0.0.1:3001`).
- API: Fastify. `buildApp()` in `app.ts` returns the app without listening, and tests call it via `app.inject`. `server.ts` handles config and listening.
- Config is zod-validated from env (`apps/api/src/config.ts`). See `.env.example`. `CORS_ORIGINS` must be set in production.
- The repo is open source: no secrets in the extension (it ships as readable JS), service keys stay server-side, and Jev should sit behind a provider interface so the project runs without a Jev key.
