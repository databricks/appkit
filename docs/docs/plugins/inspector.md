---
sidebar_position: 6
---

# Inspector plugin

Adds an opt-in command palette to AppKit apps that can:

- detect the current screen and likely AppKit plugin
- assemble a redacted browser + server context bundle
- generate an AI-ready prompt for the current screen
- forward that bundle to a localhost bridge for editor workflows

The inspector is intentionally bridge-oriented. It never talks to Cursor, Claude, or any other editor directly from the browser.

## Basic usage

```ts
import { createApp, inspector, server } from "@databricks/appkit";

await createApp({
  plugins: [
    server(),
    inspector({
      bridgeTarget: "http://127.0.0.1:55107/context",
    }),
  ],
});
```

## Activation

The inspector is off by default.

- Enable it for the current browser and persist the opt-in with `?inspect=1`
- Disable it and clear the persisted opt-in with `?inspect=0`

Once enabled, open the inspector command palette with `Cmd+K` on macOS or `Ctrl+K` on other platforms. The palette exposes three actions:

- `Explain this screen`
- `Copy AI prompt`
- `Send to local bridge`

## What the inspector collects

When enabled, the client bootstrap captures:

- current route and document title
- a trimmed visible-text excerpt
- selected text
- recent same-origin network activity
- recent user-triggered click actions with element references
- selected text and the selected DOM element when available

The server plugin enriches that snapshot with:

- likely AppKit plugin metadata
- registered endpoints for the matched plugin
- recent correlated server-side request events for the current inspector session

## Local bridge

The reference bridge lives in `tools/inspector-local-bridge.ts`.

Run it locally with:

```bash
pnpm tsx tools/inspector-local-bridge.ts
```

The bridge listens on `http://127.0.0.1:55107` by default and accepts:

- `POST /context`

Optional helper endpoints:

- `GET /health`
- `GET /last`

## Configuration

```ts
inspector({
  enabledByDefault: false,
  bridgeTarget: "http://127.0.0.1:55107/context",
  maxForwardPayloadBytes: 24_000,
  maxRecentEvents: 20,
  maxStoredSessions: 50,
  maxStoredEventsPerSession: 100,
});
```

## Security model

- The browser command palette is opt-in unless `enabledByDefault` is set.
- Bridge forwarding is restricted to localhost targets only.
- URL query parameters with keys like `token`, `auth`, `secret`, `cookie`, and `password` are redacted before forwarding.
- Oversized payloads are trimmed before they are sent to the local bridge.
- The browser only talks to the AppKit server. The server performs the localhost bridge handoff.

## Development notes

The inspector uses the shared server bootstrap path, so the overlay works consistently in:

- Vite dev serving
- static serving
- remote tunnel HTML injection

The `apps/dev-playground` app includes the inspector as the reference integration for routes such as `analytics`, `files`, and `genie`.
