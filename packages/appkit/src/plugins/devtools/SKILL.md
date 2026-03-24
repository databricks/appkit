# AppKit DevTools — Agent Skill

Use this skill when the user asks you to look at their running app, debug a UI element, fix something on screen, or when they mention devtools. This skill connects you to a live browser context captured by the AppKit devtools.

## Prerequisites

The user must have:
1. An AppKit app running with the `devtools()` plugin enabled
2. The devtools activated in the browser (`?inspect=1` or `Cmd+K`)

No separate bridge process is needed — the devtools plugin serves context directly from the AppKit server.

## How it works

1. The user opens the devtools palette in their browser (`Cmd+K`)
2. They pick a UI element and describe what they want changed
3. The devtools captures full page context and stores it on the AppKit server
4. You read that context using the CLI commands below

## CLI commands

Run these in the project root to get live browser context:

```bash
# Quick summary — what's the current state?
npx appkit inspect

# Full AI prompt — includes the user's request, picked element, page context, and server events
npx appkit inspect prompt

# Raw context bundle as JSON — for programmatic use
npx appkit inspect context
```

The CLI auto-discovers the running AppKit server (defaults to `http://localhost:8000/api/devtools`). Set `DEVTOOLS_URL` to override, or `PORT` to change the port.

## Workflow

When the user asks you to act on something they see in their app:

1. Run `npx appkit inspect` to check if context is available
2. Run `npx appkit inspect prompt` to get the full prompt with their request
3. Read the prompt — it contains:
   - The user's request (what they want changed)
   - The target element (tag, selector, DOM path, classes, text)
   - The current route and likely AppKit plugin
   - Recent network activity and server events
   - A visible page text excerpt
4. Use the context to find the relevant source files and make the changes
5. If you need the raw bundle for specific field values, run `npx appkit inspect context`

## Matching source files to context

The prompt includes the "likely AppKit plugin" (e.g., analytics, genie, files). Use this to narrow your search:

- **Route**: Maps to a page component in `template/client/src/pages/` or `apps/dev-playground/client/src/pages/`
- **Plugin name**: Maps to server code in `packages/appkit/src/plugins/{name}/`
- **API endpoints**: Listed in the prompt, e.g. `/api/analytics/query/demo`
- **UI components**: In `packages/appkit-ui/src/react/`
- **Element selector/classes**: Use these to grep for the specific component

## Example

User picks a chart element and types "make the colors more accessible":

```bash
$ npx appkit inspect prompt
You are helping a developer with a Databricks AppKit screen.

User request: make the colors more accessible

Target element: div.chart-container | role=img | "Revenue by Quarter"
...
```

You would then search for the chart component, find the color palette, and update it with accessible colors.

## Channel mode (experimental)

Channel mode pushes devtools context directly into your active Claude Code or Isaac session via the MCP channel protocol. Instead of spawning a new agent process, the prompt arrives in your already-running session.

### Setup

Run the setup command to get registration instructions:

```bash
npx appkit inspect channel-setup
```

This prints commands tailored to whichever agent CLIs you have installed. The general steps are:

1. Register the MCP server (once):

```bash
claude mcp add --scope user --transport stdio appkit-devtools -- node <path>/channel-server.js
```

2. Start your agent with channel support:

```bash
claude --dangerously-load-development-channels server:appkit-devtools
```

### How it works

The channel server polls `GET /api/devtools/last` every second. When the user picks an element in the browser and submits a prompt, the channel server detects the new context and pushes the prompt directly into the active session.

### MCP tools (pull fallback)

Even without channel mode, the MCP server exposes two tools you can call on demand:

- `get_devtools_context` — fetches the latest context bundle
- `get_devtools_prompt` — fetches the latest AI prompt text

### Environment variables

- `DEVTOOLS_URL` — full URL to the devtools API (e.g. `http://localhost:9000/api/devtools`)
- `DATABRICKS_APP_PORT` — port number (defaults to 8000)

## HTTP endpoints (advanced)

If you need to hit the server directly:

- `GET http://localhost:8000/api/devtools/last-prompt` — plain text prompt
- `GET http://localhost:8000/api/devtools/last` — JSON with `{ bundle, prompt, receivedAt }`
- `GET http://localhost:8000/api/devtools/last-summary` — quick summary object
