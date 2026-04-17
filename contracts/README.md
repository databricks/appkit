# AppKit Data Contracts

Proto definitions that are the single source of truth for the interfaces
between AppKit components: TS/Python/Rust backends, the React SDK, the
`databricks` CLI, the agent-eval framework, and scaffolding tooling.

See the design doc (linked from `docs/docs/contracts.md`) for the full
five-contract plan. This directory ships the first slice of that plan —
`appkit/v1/wire.proto` — as an intro.

## Layout

```
contracts/
  buf.yaml           # buf module + lint/breaking rules
  buf.gen.yaml       # codegen config (TS via @bufbuild/protoc-gen-es)
  appkit/v1/
    wire.proto       # HTTP + SSE envelope, error frames, result-format enum
```

## Regenerating TS bindings

```bash
pnpm --filter=@databricks/appkit-contracts generate
```

Generated output lands in `packages/contracts/src/generated/` and is re-exported
from `@databricks/appkit-contracts`.

## Follow-ups

Planned additions, tracked against the design doc:

- `appkit/v1/query.proto` — typed SQL query schemas (DESCRIBE QUERY -> bindings).
- `appkit/v1/plugin.proto` — plugin manifest, replacing the JSON Schema in `packages/shared/src/schemas/plugin-manifest.schema.json`.
- `agenteval/v1/*.proto` — eval runs, scorers, traces, streaming envelope.
- `appkit/v1/deploy.proto` — app manifest consumed by `databricks apps deploy`.
