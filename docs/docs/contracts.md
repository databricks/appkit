---
title: Data Contracts
sidebar_position: 9
---

# Data Contracts

AppKit exposes several interfaces that today are kept in sync by convention:
the HTTP + SSE surface between backend and React SDK, the typed query pipeline
(`DESCRIBE QUERY` → `QueryRegistry`), the plugin manifest schema, and the app
contract the `databricks` CLI consumes at deploy time. As AppKit grows second
and third backend implementations (Python, Rust) the cost of keeping those
conventions in sync grows with the language count.

The `contracts/` directory at the repo root holds the proto definitions that
will become the single source of truth for all of these interfaces. Each
language binding is regenerated from the same protos; consumers import what
they need.

## Current scope

This intro PR ships the first slice:

- **`appkit/v1/wire.proto`** — the HTTP + SSE envelope. Defines `SseEnvelope`,
  `SseError`, and `ResultFormat` (warehouse result-format negotiation).
  Consumed today by `packages/appkit/src/stream/types.ts` as a type-level
  compatibility anchor; follow-up PRs will retire the hand-written
  `BufferedEvent` in favor of the generated type.

## Regenerating

```bash
pnpm contracts:lint      # buf lint over contracts/
pnpm contracts:generate  # regenerate TS bindings into packages/contracts/src/generated/
```

Generated output lives under `packages/contracts/src/generated/` and is
re-exported from `@databricks/appkit-contracts`.

## Planned follow-ups

Per the design doc (see [Enforcing Data Contracts in
AppKit](https://docs.google.com/document/d/1yWWt7sLVpmuDhYs-bIWFEE9hiI6MlxjO6YS4AuN4v6k/edit)),
four more contracts will land in subsequent PRs:

- `appkit/v1/query.proto` — typed SQL query schemas (`DESCRIBE QUERY` →
  bindings in every language, replacing today's TS-only
  `QueryRegistry` augmentation).
- `appkit/v1/plugin.proto` — plugin manifest, replacing
  `packages/shared/src/schemas/plugin-manifest.schema.json`.
- `agenteval/v1/*.proto` — versioned eval framework ↔ app protocol.
- `appkit/v1/deploy.proto` — app manifest consumed by
  `databricks apps deploy` (runtime, entrypoint, build steps, static-asset
  layout, health route, required env).
