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

Omnigent owns the agent loop: sessions, history, approvals. Use the [`agents`](./agents.md) plugin when you want AppKit to own the loop against one serving endpoint. Use `omnigent` when you want the harnesses themselves.

## Install

```ts
import { createApp, server } from "@databricks/appkit";
import { omnigent } from "@databricks/appkit/beta";

await createApp({
  plugins: [
    server(),
    omnigent({ instructions: "You help the team explore order data." }),
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

## Configuration

| Option | Default | |
|---|---|---|
| `instructions` | a generic assistant prompt | System instructions for every session |
| `harnesses` | `claude-sdk`, `pi`, `openai-agents` | Harnesses users may pick |
| `defaultHarness`, `defaultModel` | first available | |

Each harness is offered the Unity Gateway `system.ai` models whose API it speaks: Claude Agent SDK the Anthropic Messages API, Pi the Codex Responses API, OpenAI Agents SDK the OpenAI Responses API.

## Routes

All routes are under `/api/omnigent` and act as the signed-in user. Sessions are limited to the ones this app created.

| Route | |
|---|---|
| `GET /status` | Whether managed Omnigent and Sandbox hosts are usable |
| `GET /harnesses` | Harnesses available to the user, each with the models it can drive |
| `GET /sessions`, `POST /sessions` | List, create (`harness`, `model`, `message`, `title`) |
| `GET /sessions/:id`, `DELETE /sessions/:id` | Snapshot (items, status), delete |
| `POST /sessions/:id/messages` | `{ "text": "..." }` |
| `GET /sessions/:id/stream` | Server-sent events (Omnigent's session stream, which replays from `Last-Event-ID`) |
| `POST /sessions/:id/interrupt` | Stop the current turn |

Creating a session returns once its Sandbox host is up, about 30 seconds on a cold start.

## Local development

With `NODE_ENV=development` and no forwarded token, the plugin calls Omnigent as the developer, with the token of the app's local Databricks CLI profile.

## Limits

- **Beta, in Omnigent's regions.** The plugin needs the workspace's managed Omnigent; it does not run Omnigent itself.
- **Only gateway harnesses.** Harnesses that sign in with their vendor (Cursor, Copilot, Gemini and others) are not offered. Codex is not offered yet: on a Sandbox host, its brokered sign-in rejects the Codex CLI version the Sandbox ships.
- **Broad app scope.** The `all-apis` scope lets the app call any API the user can, on the user's behalf.
