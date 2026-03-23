---
sidebar_position: 6
---

# DevTools plugin

Adds an opt-in command palette to AppKit apps that can:

- detect the current screen and likely AppKit plugin
- assemble a redacted browser + server context bundle
- generate an AI-ready prompt for the current screen
- pick a specific UI element and describe what should change
- forward that bundle to a localhost bridge for editor workflows
- expose context via a CLI for coding agents to consume

The devtools is intentionally bridge-oriented. It never talks to Cursor, Claude, or any other editor directly from the browser.

## Basic usage

```ts
import { createApp, devtools, server } from "@databricks/appkit";

await createApp({
  plugins: [
    server(),
    devtools({
      bridgeTarget: "http://127.0.0.1:55107/context",
    }),
  ],
});
```

## Activation

The devtools is off by default.

- Enable it for the current browser and persist the opt-in with `?inspect=1`
- Disable it and clear the persisted opt-in with `?inspect=0`

Once enabled, open the devtools command palette with `Cmd+K` on macOS or `Ctrl+K` on other platforms. The palette exposes these actions:

- `Explain this screen` — generate a prompt with browser context and correlated server events
- `Copy AI prompt` — copy the generated prompt to clipboard
- `Pick an element` — select a UI element visually, then describe what you want an agent to do with it
- `Send to local bridge` — forward the context bundle to your localhost bridge
- `Network waterfall` — visual timeline of recent HTTP requests
- `SSE stream debugger` — view active Server-Sent Event streams across all plugins
- `Query inspector` — recent analytics SQL queries with cache hits, timing, and parameters
- `Performance spotlight` — slow requests, latency percentiles, and error counts
- `Plugin health` — per-plugin request counts, error rates, and latency breakdown
- `Clear context` — reset all recorded data

## Element picker

The **Pick an element** command activates an element picker overlay. Hover over any element to highlight it, then click to select it. After picking:

1. The palette reopens showing the picked element details (tag, selector, text)
2. A prompt input asks "What should change?"
3. Type your intent (e.g., "make this button larger", "fix the alignment", "add a loading state")
4. Press Enter or click Send — the context bundle and generated prompt are forwarded to the bridge

A coding agent can then read the context via the CLI.

## Dock mode

Press `Cmd+Shift+K` to dock the palette to the right side of the screen as a persistent sidebar. In docked mode:

- The app remains interactive behind the panel (no backdrop overlay)
- Drag the left edge to resize the sidebar width
- Data views (streams, queries, performance, health) auto-refresh every 2 seconds
- Press `Cmd+Shift+K` again to undock back to the centered modal

## CLI

The `appkit inspect` command reads context from the running AppKit server:

```bash
# Quick summary of the latest context
npx appkit inspect

# Full AI prompt with user request, picked element, and page context
npx appkit inspect prompt

# Raw JSON context bundle
npx appkit inspect context
```

Set `DEVTOOLS_URL` to override the default server address (`http://localhost:8000/api/devtools`).

## Agent skill

The file `packages/appkit/src/plugins/devtools/SKILL.md` is a ready-made agent skill that teaches coding agents (Cursor, Claude Code) how to use the devtools CLI. Copy or symlink it into your agent's skill directory.

## What the devtools collects

When enabled, the client bootstrap captures:

- current route and document title
- a trimmed visible-text excerpt
- selected text and the selected DOM element
- the explicitly picked element (via the element picker)
- the user's prompt describing what should change
- recent same-origin network activity
- recent user-triggered click actions with element references
- recent console output (log, warn, error) with stack traces

The server plugin enriches that snapshot with:

- likely AppKit plugin metadata
- registered endpoints for the matched plugin
- recent correlated server-side request events for the current devtools session

## Local bridge

The reference bridge lives in `tools/devtools-local-bridge.ts`.

Run it locally with:

```bash
npx tsx tools/devtools-local-bridge.ts
```

The bridge listens on `http://127.0.0.1:55107` by default and accepts:

- `POST /context` — receive a context bundle (with optional prompt)

Helper endpoints:

- `GET /health` — health check
- `GET /last` — full last payload as JSON (`{ bundle, prompt, receivedAt }`)
- `GET /last-summary` — summary object
- `GET /last-prompt` — plain text prompt (ready to pipe)

Environment variables:

- `DEVTOOLS_BRIDGE_HOST` — bind host (default `127.0.0.1`)
- `DEVTOOLS_BRIDGE_PORT` — bind port (default `55107`)
- `DEVTOOLS_BRIDGE_LOG_MODE` — `summary`, `full`, or `both` (default `both`)

## Configuration

```ts
devtools({
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

The devtools uses the shared server bootstrap path, so the overlay works consistently in:

- Vite dev serving
- static serving
- remote tunnel HTML injection

The `apps/dev-playground` app includes the devtools as the reference integration for routes such as `analytics`, `files`, and `genie`.
