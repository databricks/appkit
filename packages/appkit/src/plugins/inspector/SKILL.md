# AppKit Inspector — Agent Skill

Use this skill when the user asks you to look at their running app, debug a UI element, fix something on screen, or when they mention the inspector. This skill connects you to a live browser context captured by the AppKit inspector.

## Prerequisites

The user must have:
1. An AppKit app running with the `inspector()` plugin enabled
2. The inspector activated in the browser (`?inspect=1` or `Cmd+K`)

No separate bridge process is needed — the inspector plugin serves context directly from the AppKit server.

## How it works

1. The user opens the inspector palette in their browser (`Cmd+K`)
2. They pick a UI element and describe what they want changed
3. The inspector captures full page context and stores it on the AppKit server
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

The CLI auto-discovers the running AppKit server (defaults to `http://localhost:8000/api/inspector`). Set `INSPECTOR_URL` to override, or `PORT` to change the port.

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

## HTTP endpoints (advanced)

If you need to hit the server directly:

- `GET http://localhost:8000/api/inspector/last-prompt` — plain text prompt
- `GET http://localhost:8000/api/inspector/last` — JSON with `{ bundle, prompt, receivedAt }`
- `GET http://localhost:8000/api/inspector/last-summary` — quick summary object
