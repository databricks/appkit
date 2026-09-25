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

Run the app locally, then open a separate terminal for an opt-in OBO proxy:

```sh
NODE_ENV=development npx appkit dev-obo \
  --profile <your-user-profile> \
  --target http://127.0.0.1:3000 \
  --port 3001
```

Open `http://127.0.0.1:3001`. Choose a user profile for the same workspace as
the app. The CLI obtains credentials using that explicit profile and injects
`x-forwarded-access-token`, `x-forwarded-user`, and optional email headers into
requests to the local app. It never writes or prints tokens, and refreshes its
in-memory credentials after 30 seconds of use. Refresh failures reject instead
of falling back to SP.

The proxy accepts only loopback HTTP targets and same-origin browser requests.
It is disabled in production and deployed Apps. Use it only with a trusted local
app and do not publish it through a tunnel. WebSocket upgrades are not proxied;
HTTP and SSE requests work. This emulates user credentials, not the platform's
consent flow or resource provisioning. Without this proxy, the existing marked
development fallback still applies.
