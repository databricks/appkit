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

On the agents HTTP execution routes (`/invocations`, `/responses`, and
`/api/agents/chat`), each plugin-toolkit tool call runs in user scope through
`executeTool`, including tool calls made by sub-agents. A plugin tool call without
usable user credentials rejects; it never runs as the service principal. The
marked development fallback below is the only missing-token exception. The agent's
model call and hand-rolled tools are not wrapped in user scope. One plugin tool
leaves user scope on purpose: in a mixed agent, an AI Functions task with
`auth: "service-principal"` runs as the app. In an on-behalf-of-user agent, it
runs as the user.

## Which built-in surfaces run as the user

The default is the **service principal**. Work runs on behalf of the user only inside a caller scope: `appkit.asUser(req)`, a route that opens one, or a query file that selects the user lane. There is no global "OBO everywhere" mode, so identity is decided per surface:

| Surface | Runs as | Why |
| --- | --- | --- |
| Genie routes | signed-in user (OBO) | the built-in route runs every call in user scope |
| Serving plugin (deprecated) routes | signed-in user (OBO) | the built-in route runs every call in user scope; prefer the agents plugin |
| AI Functions task routes and tools | service principal by default; signed-in user (OBO) when the task sets `auth: "on-behalf-of-user"` | each task declares its identity with `auth`; programmatic methods (`run`, `classify`, `extract`, `decide`) run as the service principal unless you call them inside `appkit.asUser(req)` |
| Analytics `.obo.sql` queries | signed-in user (OBO) | the `.obo.sql` file name selects the user lane |
| Analytics `.sql` queries, Files, and other plugin calls | app service principal | user only inside `appkit.asUser(req)`, or for Files volumes configured with `auth: "on-behalf-of-user"` |
| Agents HTTP routes: the model (LLM) call | app service principal | the model adapter builds its own service-principal client, and the route does not open user scope |
| Agents HTTP routes: plugin-toolkit tool calls (`plugin:<name>`) | signed-in user (OBO), except AI Functions tasks with `auth: "service-principal"` | `executeTool` opens user scope for each call; without user credentials the call rejects. An AI Functions service-principal task runs as the app, except inside an on-behalf-of-user agent, where it runs as the user |
| Agents HTTP routes: hand-rolled `tool({ execute })` | app service principal | `execute` receives only the validated arguments and runs in the app context, as before |
| Standalone `runAgent` (no HTTP request) | app service principal by default | there is no request, so no user scope unless you pass `caller` (see [Standalone agents](#standalone-agents)) |

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

## App-only resources and missing credentials

The manifest capability contract keeps `secret`, `database`, and `postgres`
app-only for the new `appkit.asUser` and `runInCallerContext` APIs. Accessing
those resources through these caller-scoped plugin APIs or tools
raises a clear error identifying the resource by its manifest alias, or its type
when no alias is available. The message states that the resource is app-only in
this version of AppKit and does not support OBO execution through these APIs.
The check applies when using cached handles inside a later user scope too.
It does not reject unrelated plugins merely because an app-only plugin is
installed. Required resources, runtime requirements, and configured optional
resources determine the plugin's resource capability.

Deprecated `plugin.asUser` and `runInUserContext`, direct request-based tool
dispatch, and the existing agents HTTP routes retain their established resource
behavior, including Lakebase per-user routing. They still establish user identity
and reject missing production credentials; they never fall back to SP by omission.
Using a deprecated entry point inside a new guarded scope cannot disable its guards.

Missing-token messages distinguish OBO-capable resources from generic operations.
For an OBO-capable resource, the message explains that no user token was forwarded
and the app may be deployed service-principal-only. Otherwise the generic missing
user token error remains. The app-level check uses the registered plugins' active
resource metadata because no individual plugin has been selected yet.

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
