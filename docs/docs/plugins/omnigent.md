# Omnigent

<!-- AUTO-GENERATED: stability-banner-start -->
:::warning Beta plugin
This plugin is currently **beta**. APIs may change between minor releases. Import from `@databricks/appkit/beta`. See [Plugin Stability Tiers](./stability.md).
:::
<!-- AUTO-GENERATED: stability-banner-end -->

The `omnigent` plugin embeds [Omnigent](https://github.com/omnigent-ai/omnigent), the open-source agent meta-harness, in a Databricks AppKit app. Your users get Claude Agent SDK, Codex, Pi and OpenAI Agents SDK sessions inside the app:

- **Model calls go through Unity AI Gateway** as the app's service principal.
- **The app's tools run as the signed-in user**, so Unity Catalog grants apply.

Omnigent owns the agent loop: sessions, history, approvals. The plugin runs it safely inside a Databricks App. Use the [`agents`](./agents.md) plugin when you want AppKit to own the loop against one serving endpoint. Use `omnigent` when you want the harnesses themselves.

## Install

```ts
import { createApp, getExecutionContext, server } from "@databricks/appkit";
import { defineTool, omnigent } from "@databricks/appkit/beta";
import { z } from "zod";

await createApp({
  plugins: [
    server(),
    omnigent({
      instructions: "You help the team explore order data.",
      tools: {
        count_orders: defineTool({
          description: "Count this month's orders",
          schema: z.object({}),
          annotations: { effect: "read" },
          execute: async () => {
            // Runs as the session's user.
            const { client } = getExecutionContext();
            return client.statementExecution.executeStatement({
              warehouse_id: process.env.DATABRICKS_WAREHOUSE_ID!,
              statement:
                "SELECT count(*) FROM main.shop.orders WHERE date_trunc('MONTH', order_date) = date_trunc('MONTH', current_date())",
              wait_timeout: "30s",
            });
          },
        }),
      },
    }),
  ],
});
```

The app also needs:

- **Python.** Add a `pyproject.toml` with `requires-python = ">=3.12,<3.13"` and `omnigent[databricks]`, plus a `uv.lock`. Databricks Apps then builds a Python 3.12 venv next to `npm install`. A plain `requirements.txt` gets Python 3.11, which Omnigent does not support. The lockfile must reference public PyPI.
- **Harness CLIs.** Add them to your `package.json`, so you pin their versions: `@anthropic-ai/claude-code`, `@openai/codex` and `@earendil-works/pi-coding-agent`. The plugin only offers harnesses whose CLI is installed. The Claude Agent SDK's bundled CLI is too old for current Claude models, so add `@anthropic-ai/claude-code` even though the SDK ships one.
- **Start with `node`.** In `app.yaml`, use `command: ["node", "server.js"]`, not `npm run start`. npm does not pass SIGTERM on, so the plugin never gets to stop its child processes. As a backstop, each child also exits when Node does, so a redeploy still succeeds.
- **User API scopes.** Grant the scopes your tools need (for example `sql`), so tools can run as the user.

## Configuration

| Option | Default | |
|---|---|---|
| `instructions` | a generic assistant prompt | System instructions for every session |
| `tools` | none | `defineTool()` entries, served to every harness over MCP |
| `pluginTools` | none | `true`, or a list of plugin names, to also serve other plugins' tools (for example `genie`) |
| `defaultMode` | `ask` | `auto`, `ask` or `read` |
| `harnesses` | `claude-sdk`, `codex`, `pi`, `openai-agents` | Harnesses users may pick |
| `defaultHarness`, `defaultModel` | first available | |
| `runtime.python` | `./.venv/bin/python` | |
| `runtime.home` | `$TMPDIR/appkit-omnigent` | The plugin's state directory |
| `runtime.hostIdleMs` | 30 min | Stop a user's Omnigent host after this long idle |

Each harness is offered the Unity AI Gateway `system.ai` models whose API it speaks: Claude Agent SDK the Anthropic Messages API, Codex and Pi the Codex Responses API, OpenAI Agents SDK the OpenAI Responses API.

## Modes

Tools whose `annotations.effect` is `write`, `update` or `destructive` are writes:

- `auto` runs everything.
- `ask` pauses on writes (and on Omnigent's own OS tools) until the user approves.
- `read` denies writes.

Omnigent enforces the mode on every harness. A pending approval appears on the session as `pending_elicitations`. Resolve it with `POST /api/omnigent/sessions/:id/elicitations/:eid` and `{"action": "accept" | "decline" | "cancel"}`.

## Routes

All routes are under `/api/omnigent` and scoped to the signed-in user.

| Route | |
|---|---|
| `GET /harnesses` | Harnesses available to the user, each with the gateway models it can drive |
| `GET /sessions`, `POST /sessions` | List, create (`harness`, `model`, `mode`, `message`, `title`) |
| `GET /sessions/:id`, `DELETE /sessions/:id` | Snapshot (items, status, mode, pending approvals), delete |
| `POST /sessions/:id/messages` | `{ "text": "..." }` |
| `GET /sessions/:id/stream` | Server-sent events (Omnigent's session stream, which replays from `Last-Event-ID`) |
| `POST /sessions/:id/interrupt` | Stop the current turn |
| `PUT /sessions/:id/mode` | `{ "mode": "ask" }` |
| `POST /sessions/:id/elicitations/:eid` | Resolve a pending approval |
| `GET /status` | Runtime health: sandbox, hosts, gateway counters |

## React

`@databricks/appkit-ui/react/beta` has three headless hooks for building the UI:

```tsx
import {
  useOmnigentHarnesses,
  useOmnigentSession,
  useOmnigentSessions,
} from "@databricks/appkit-ui/react/beta";

function Thread({ sessionId }: { sessionId: string | null }) {
  const s = useOmnigentSession({ sessionId });
  return (
    <>
      {s.items.map((item, i) => <Item key={item.id ?? i} item={item} />)}
      {s.draft && <p>{s.draft}</p>}
      {s.approvals.map((a) => (
        <button key={a.elicitation_id} onClick={() => s.approve(a.elicitation_id)}>
          Allow: {a.params?.message}
        </button>
      ))}
      <Composer onSend={(text) => (s.sessionId ? s.send(text) : s.start({ message: text }))} />
    </>
  );
}
```

- **`useOmnigentSession`** loads a session and keeps its stream open. The live text of the running turn is in `draft`, and `items`, `status`, `session.mode` and `approvals` refresh as events arrive. Its actions are `start`, `send`, `interrupt`, `approve`, `decline`, `setMode`, `refresh` and `reset`.
- **`useOmnigentHarnesses`** lists the harnesses the user can pick, each with its gateway models.
- **`useOmnigentSessions`** lists the user's threads and can delete them.

The dev playground's `/omnigent` page (`OMNIGENT_ENABLED=1`) is a complete example.

## How it works

- **One Omnigent server, one host per user.** The server listens on loopback in Omnigent's header-auth mode, under a random header name only the plugin knows. Each active user gets their own host process, registered as that user; Omnigent only runs a session on its owner's host. An idle host stops after `runtime.hostIdleMs`.
- **No credential in any child process.** The harnesses' Databricks profile points at a model gateway inside the plugin, on loopback, with a placeholder token. The gateway forwards only model-serving paths to the workspace and adds the service principal's token. Every other path returns 403. Codex only trusts public TLS roots, so it reaches the gateway over plain http on loopback; the others use https with a certificate the plugin generates.
- **Tools over MCP.** Each session's bundle points an MCP server at the app's own `/api/omnigent/mcp`, with a key that is an HMAC over a nonce and the user. The plugin verifies the key, then runs the tool inside that user's AppKit execution context, using their latest forwarded token. Keys survive restarts because nothing is stored.
- **Codex runs sandboxed.** Codex has its own shell. Its binary runs through a bubblewrap wrapper that gives it:
  - its own PID namespace
  - the plugin's state directory masked
  - only the user's home and work directory bound in
  - the `/proc` entries of the app's own processes hidden

  Without bubblewrap on `PATH` (or bundled with Codex), Codex is not offered.

## Limits

- **Sessions live in the container.** Omnigent keeps them in SQLite under the plugin's state directory, so they survive a process restart but not a redeploy.
- **Only gateway harnesses.** Harnesses that sign in with their vendor (Cursor, Copilot, Gemini and others) bypass Unity AI Gateway, so they are not offered. Native terminal harnesses (`claude-native`, `codex-native`, `pi-native`) are not offered yet: they need tmux and a terminal client.
- **Tool calls need a recent visit.** A tool call runs on the user's most recent forwarded token. After a restart, a user's tools work again once they make a request to the app.
- **Shared gateway limits.** All users' model traffic uses the service principal's gateway limits.
