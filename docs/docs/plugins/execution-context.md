---
sidebar_position: 5
---

# Execution context

AppKit uses the service principal by default. Open a caller scope when an
operation should use the requesting user's Databricks permissions.

## User-scoped operations

Prefer a scope block for handlers that perform multiple operations:

```ts
const result = await appkit.asUser(req).run(async (kit) => {
  const orders = await kit.analytics.query("orders");
  return orders;
});

// Shorthand for one operation:
await appkit.asUser(req).analytics.query("orders");

// With no caller scope, a plain call uses the service principal:
await appkit.analytics.query("metrics");
```

One immutable caller context is shared by the block and its plugin handles.
Nested operations, tools, and plain app handles used inside the block inherit
that context. Async work and lazy stream consumption preserve the caller.
There is no public `asApp()` and scoped handles cannot chain another `asUser()`.
Group principals are deferred.

The Apps proxy supplies `x-forwarded-access-token` and `x-forwarded-user`, both
required in production. `x-forwarded-email` is optional. Only trust these headers
behind the authenticated Apps proxy or your own trusted authentication boundary.

`plugin.asUser(req)` remains available with a one-time deprecation warning.
New code should use `appkit.asUser(req)`.

## Tools and agents

`PluginContext.executeTool` inherits an existing caller scope. Without one, it
establishes user scope from the request, preserving the original fail-closed OBO
default. Missing credentials reject before the provider executes. An existing
caller takes precedence over conflicting or absent request credentials.

The agents HTTP execution routes (`/invocations`, `/responses`, and
`/api/agents/chat`) establish user scope at entry by default, including all nested
tool calls. Missing credentials reject the request before the agent runs.
The marked development fallback below is the only missing-token exception.

## Which built-in surfaces run as the user

The default is the **service principal**. Work runs on behalf of the user only inside a caller scope: `appkit.asUser(req)`, a route that opens one, or a query file that selects the user lane. There is no global "OBO everywhere" mode, so identity is decided per surface:

| Surface | Runs as | Why |
| --- | --- | --- |
| Genie routes | signed-in user (OBO) | the built-in route runs every call in user scope |
| Serving plugin (deprecated) routes | signed-in user (OBO) | the built-in route runs every call in user scope; prefer the agents plugin |
| Analytics `.obo.sql` queries | signed-in user (OBO) | the `.obo.sql` file name selects the user lane |
| Analytics `.sql` queries, Files, and other plugin calls | app service principal | user only inside `appkit.asUser(req)`, or for Files volumes configured with `auth: "on-behalf-of-user"` |
| Agents HTTP routes: the model (LLM) call | app service principal | the routes open user scope, but the model adapter builds its own service-principal client, so the model call does not use the user token |
| Agents HTTP routes: plugin-toolkit tool calls (`plugin:<name>`) | signed-in user (OBO) | `executeTool` inherits the route's user scope |
| Agents HTTP routes: hand-rolled `tool({ execute })` | signed-in user (OBO), for AppKit calls inside `execute` | `execute` runs inside the route's user scope, so plugin handles and `getWorkspaceClient()` resolve to the user |
| Standalone `runAgent` (no HTTP request) | app service principal | there is no request, so no user scope |

So an agent's **model inference runs as the service principal**, while the tools it calls over the built-in HTTP routes run on behalf of the user. See the [agents plugin](./agents.md) for the tool-level detail.

## Context helpers and cache isolation

Exported from `@databricks/appkit`:

- `getCurrentPrincipalKey()`: `app` or `user:<id>`, used to partition cache entries.
- `getCurrentActorId()`: initiating user ID, when available, for audit and telemetry.
- `getWorkspaceClient()`: workspace client for the current execution.
- `getWarehouseId()`: resource configuration, separate from execution identity.
- `getWorkspaceId()`: workspace ID as a promise.

The old context helpers remain as deprecated compatibility aliases. Cache keys
now include the principal namespace even when an explicit legacy user key is
supplied. Existing stored entries will have a cold miss after upgrading; users
and SP continue to have separate cache entries and in-flight work.

## Standalone agents

Standalone `runAgent` can opt into user execution without an HTTP request:

```ts
await runAgent(agent, {
  messages: "Summarize my data",
  caller: {
    token: userToken,
    principal: { type: "user", userId },
    host: "https://your-workspace.cloud.databricks.com",
    workspaceId,
  },
});
```

Get credentials through a trusted authentication flow, never from model output.
The caller applies to plugin initialization, model adapters, tools, and nested
agents. Omitting it inherits an existing caller scope or defaults to SP.
Invalid explicit credentials reject even in development. No service context or
CLI profile is initialized implicitly. Standalone execution still has no approval
gate and is intended for trusted scripts and evaluations.

## Development fallback

With `NODE_ENV=development`, `asUser(req)` without a token logs a warning and
runs with default app credentials, marked `DEV_OBO_FALLBACK`. If a caller scope
is already open, fallback retains it instead of widening to SP. The marker does
not leak outside the scope. Production never falls back when credentials are
missing.

## Credential expiration and telemetry

A structured downstream HTTP 401 inside a caller scope throws
`IdentityExpiredError` with code `IDENTITY_EXPIRED`. It includes the existing
token fingerprint, not the token or upstream credential-bearing error. Obtain
fresh user credentials before retrying. Non-401 failures and SP execution keep
their existing behavior. Plugin `execute()` preserves its failed-result envelope
and adds the typed error in the optional `error` field; SSE streams expose `IDENTITY_EXPIRED`
in the error payload's `errorCode` field.

AppKit-managed spans include `appkit.execution.principal` (`app` or `user`) and
`appkit.execution.principal_id` (user or SP ID, or `app` before initialization).
`appkit.execution.actor_id` is present when an initiating user exists. Tokens
are never attached to these attributes.

## Real user execution locally

Set `DATABRICKS_TOKEN` and `DATABRICKS_HOST` in the app's `.env` to use a user
token directly:

```dotenv
DATABRICKS_HOST=https://your-workspace.cloud.databricks.com
DATABRICKS_TOKEN=your-user-token
```

When `DATABRICKS_TOKEN` is present, it takes precedence. AppKit uses it directly
and resolves the user ID from the configured host. Otherwise, set
`DATABRICKS_CONFIG_PROFILE` to an authenticated user profile for the same
workspace as the app. The generated template already sets the profile when you
choose one during scaffolding:

```dotenv
DATABRICKS_CONFIG_PROFILE=your-user-profile
```

Then run your usual command:

```sh
npm run dev
```

Open the app's normal localhost URL. In development, the server automatically
adds `x-forwarded-access-token`, `x-forwarded-user`, and optional email headers
before plugin routes and custom routes run. No separate proxy, target, or port
is needed. `asUser(req)` uses that user identity. Unscoped operations still use
the app's configured credentials; injecting headers does not open a caller scope.
For a genuine SP-versus-user comparison, the app credentials must belong to an
SP, not the same user profile.

Credentials stay in memory and refresh after 30 seconds of use. Initial auth and
refresh failures return 401, never a silent SP fallback. Existing forwarded user
tokens are preserved. Automatic injection runs only in `NODE_ENV=development`
and only for same-origin loopback requests, including `localhost`. Use it only
with a trusted local app. It emulates user credentials, not platform consent,
scope enforcement, or resource provisioning.

Set `APPKIT_DEV_OBO=false` in `.env` to disable automatic injection. Without a
configured token or profile, injection is also disabled. Tokenless
`asUser(req)` then keeps the existing `DEV_OBO_FALLBACK` behavior in
development.
