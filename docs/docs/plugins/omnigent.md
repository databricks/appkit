# Omnigent

<!-- AUTO-GENERATED: stability-banner-start -->
:::warning Beta plugin
This plugin is currently **beta**. APIs may change between minor releases. Import from `@databricks/appkit/beta`. See [Plugin Stability Tiers](./stability.md).
:::
<!-- AUTO-GENERATED: stability-banner-end -->

The `omnigent` plugin gives your app's users [Omnigent](https://docs.databricks.com/aws/en/omnigent/) agent sessions: Claude Agent SDK, Pi and OpenAI Agents SDK, on the workspace's managed Omnigent.

- **Sessions belong to the signed-in user.** Every call carries the user's token, so a session is theirs, appears in `<workspace>/omnigent`, and is private to them until they share it.
- **Each session runs on a Databricks Sandbox**, so agent-written code runs in an isolated, Databricks-managed box with the user's own permissions.
- **Model calls go through Unity Gateway**, with its governance, limits and usage tracking.
- **Tools are Databricks-managed MCP servers**, called as the user, so Unity Catalog permissions apply.

Omnigent owns the agent loop: sessions, history, approvals. Use the [`agents`](./agents.md) plugin when you want AppKit to own the loop against one serving endpoint. Use `omnigent` when you want the harnesses themselves.

## Install

```ts
import { createApp, server } from "@databricks/appkit";
import { omnigent } from "@databricks/appkit/beta";

await createApp({
  plugins: [
    server(),
    omnigent({
      instructions: "You help the team explore order data.",
      tools: [
        { type: "sql" },
        { type: "genie", spaceId: "01f0..." },
        { type: "functions", catalog: "main", schema: "orders" },
      ],
    }),
  ],
});
```

## Workspace setup

- **Previews.** Enable the **Omnigent** and **Databricks Sandbox** previews in the workspace. Omnigent needs a region that supports Unity Gateway; Sandbox hosts are in select AWS regions.
- **The `all-apis` scope on the app.** Managed Omnigent only accepts tokens with the `all-apis` scope, which an app's user authorization cannot request itself. An account admin adds it to the app's OAuth integration once, keeping the app's existing scopes:

  ```bash
  databricks apps get <app-name> -o json   # oauth2_app_integration_id, effective_user_api_scopes
  databricks account custom-app-integration update <oauth2_app_integration_id> \
    --json '{"scopes": ["<existing scopes>", "all-apis"]}'
  ```

  The update replaces the whole scope list. New scopes can take up to an hour to reach users' tokens. A bundle deploy, or a change to the app's user API scopes, sets the scopes back to the declared list, so repeat the update after either.

`GET /api/omnigent/status` reports whether the user can reach managed Omnigent, and why not.

## Tools

`tools` lists Databricks-managed MCP servers every session can call:

| Source | Tools |
|---|---|
| `{ type: "sql" }` | Databricks SQL: run SQL statements |
| `{ type: "genie", spaceId }` | One Genie space |
| `{ type: "functions", catalog, schema, function? }` | Unity Catalog functions, for business logic as tools |
| `{ type: "ai-search", catalog, schema, index? }` | AI Search over an index |
| `{ type: "service", service }` | A Unity Gateway MCP Service, such as `system.ai.web_search` or one you registered |

Tool calls run inside the session's Sandbox with the user's own credential, so a user only reaches the data and services they can already use. The user needs the usual grants: `CAN USE` on the warehouse, access to the Genie space, `EXECUTE` on functions and MCP Services.

Tools defined in app code with `defineTool()` are not available: a Sandbox's credential cannot call back into a Databricks App. Put business logic in Unity Catalog functions instead.

## Modes

- `auto` runs every tool.
- `ask` pauses on tools that change data (and on Omnigent's own OS tools) until the user approves.
- `read` denies tools that change data.

Databricks SQL's `execute_sql` counts as a change; its `execute_sql_read_only` does not. List other tools that change data in `writeTools`. A pending approval appears on the session as `pending_elicitations`; resolve it with `POST /api/omnigent/sessions/:id/elicitations/:eid` and `{"action": "accept" | "decline" | "cancel"}`.

## Configuration

| Option | Default | |
|---|---|---|
| `instructions` | a generic assistant prompt | System instructions for every session |
| `tools` | none | Databricks-managed MCP servers, see [Tools](#tools) |
| `writeTools` | none | Further tool names that change data |
| `defaultMode` | `ask` | `auto`, `ask` or `read` |
| `harnesses` | `claude-sdk`, `pi`, `openai-agents` | Harnesses users may pick |
| `defaultHarness`, `defaultModel` | first available | |

Each harness is offered the Unity Gateway `system.ai` models whose API it speaks: Claude Agent SDK the Anthropic Messages API, Pi the Codex Responses API, OpenAI Agents SDK the OpenAI Responses API.

## Routes

All routes are under `/api/omnigent` and act as the signed-in user. Sessions are limited to the ones this app created.

| Route | |
|---|---|
| `GET /status` | Whether managed Omnigent and Sandbox hosts are usable |
| `GET /harnesses` | Harnesses available to the user, each with the models it can drive |
| `GET /sessions`, `POST /sessions` | List, create (`harness`, `model`, `mode`, `message`, `title`) |
| `GET /sessions/:id`, `DELETE /sessions/:id` | Snapshot (items, status, mode, pending approvals), delete |
| `POST /sessions/:id/messages` | `{ "text": "..." }` |
| `GET /sessions/:id/stream` | Server-sent events (Omnigent's session stream, which replays from `Last-Event-ID`) |
| `POST /sessions/:id/interrupt` | Stop the current turn |
| `PUT /sessions/:id/mode` | `{ "mode": "ask" }` |
| `POST /sessions/:id/elicitations/:eid` | Resolve a pending approval |

Creating a session returns once its Sandbox host is up, about 30 seconds on a cold start.

## Local development

With `NODE_ENV=development` and no forwarded token, the plugin calls Omnigent as the developer, with the token of the app's local Databricks CLI profile.

## Limits

- **Beta, in Omnigent's regions.** The plugin needs the workspace's managed Omnigent; it does not run Omnigent itself.
- **Only gateway harnesses.** Harnesses that sign in with their vendor (Cursor, Copilot, Gemini and others) are not offered. Codex is not offered yet: on a Sandbox host, its brokered sign-in rejects the Codex CLI version the Sandbox ships.
- **Broad app scope.** The `all-apis` scope lets the app call any API the user can, on the user's behalf.
