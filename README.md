# Auxo

Auxo is organized as a small monorepo with a shared contract between the browser
extension and the backend API.

```text
Auxo/
|-- apps/
|   |-- extension/          # Browser extension (frontend integration)
|   `-- api/                # Backend and decision pipeline
|-- packages/
|   `-- shared/             # Contracts used by both applications
|-- supabase/
|   `-- migrations/         # Database migrations
`-- evals/                  # Policy evaluation data and scripts
```

The extension and API should import their request and response types from
`packages/shared`. Contract changes should be made there before either side
depends on them.

## Getting started

Requirements: Node.js 20 or newer and pnpm.

```bash
pnpm install
pnpm test
pnpm dev:api
```

The backend starts on `http://127.0.0.1:3001`. Its first integration endpoint is
`POST /v1/decide`; request and response schemas live in `packages/shared`.
