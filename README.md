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
