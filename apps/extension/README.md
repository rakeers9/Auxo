# Extension

WXT browser extension (Chrome MV3 first, Amazon first). Owned by Person 1.

```bash
pnpm --filter @auxo/extension dev     # Chrome with the extension loaded
pnpm --filter @auxo/extension test
pnpm --filter @auxo/extension build   # .output/chrome-mv3
```

Run the API alongside it with `pnpm dev:api`. Set `WXT_API_BASE_URL` to point at another API.

Layout:

- `entrypoints/amazon.content.ts`: runs on Amazon, detects the cart, asks for a verdict, shows the overlay.
- `entrypoints/background.ts`: the only place that calls the API.
- `src/messages.ts`: types shared between the content script and the worker.
- `src/cart/`: cart detection, extraction, price parsing, hashing.
- `src/overlay/`: the shadow-DOM overlay for each lane.
- `src/api/`: the API client (timeout + fail-open).
