---
sidebar_position: 7
---

# Testing

AppKit ships a testing kit at `@databricks/appkit/testing` so you can test a plugin — including its cross-plugin tool calls and streaming responses — without a live Databricks workspace, credentials, or network access. That makes plugin tests fast and lets them run in CI, where no workspace is available.

## Goal

Exercise a plugin's real code paths — route registration, cross-plugin tool dispatch, user-scoped (on-behalf-of) execution, and per-call timeouts — against a real `PluginContext` with only its outer edges faked. Nothing about the context is reimplemented, so a test can't drift from production behavior.

The kit has two entry points plus a set of fixture helpers:

- **`mockPluginContext()`** — build a real `PluginContext` with faked edges and attach it to a plugin.
- **`expectStream(...).toEmit(...)`** — assert the ordered event types a stream emits.
- **Fixtures** — `createMockRequest`, `createMockResponse`, `mockServiceContext`, and SQL response builders.

The kit uses [Vitest](https://vitest.dev)'s `vi` for its mocks, so it is declared as an optional peer dependency. Any project that runs Vitest already satisfies it; there is nothing extra to install.

## `mockPluginContext()`

`PluginContext` is the mediator AppKit passes to every plugin — it buffers routes, tracks tool providers, and runs cross-plugin tool calls with user scoping and a timeout. `mockPluginContext()` returns the **real** context with three edges faked:

| Edge | How it's faked |
| --- | --- |
| Telemetry | A no-op mock provider — no OpenTelemetry pipeline needed. |
| Tool providers | Fakes registered through the real `registerToolProvider`, keyed by plugin then tool name. |
| Routes | The real `addRoute`/`addMiddleware` are wrapped to record what a plugin registers. |

Because the context is real, `executeTool` still resolves the user scope via `asUser(req)` and still composes the abort signal from your timeout — so those paths are genuinely under test.

### Registering fake tool responses

Pass canned responses keyed by plugin name, then tool name. A response is either a static value or a function of the call arguments and the composed abort signal:

```ts
import { mockPluginContext } from "@databricks/appkit/testing";

const mock = mockPluginContext({
  analytics: {
    // static response
    top_users: [{ user: "alice", events: 42 }],
    // function response — assert on args, or simulate slow/aborting work
    query: (args, signal) => runFakeQuery(args, signal),
  },
});
```

### Attaching to a plugin

`attach()` wires the context to a plugin the production way: it seeds an in-memory cache (if AppKit hasn't already initialized one), then calls the plugin's `attachContext`, which rebuilds telemetry and flips `isReady` to `true`. Await it before exercising any handler that reads `this.context`, `this.cache`, or gates on `isReady`:

```ts
const plugin = agents({ dir: false });
await mock.attach(plugin);
```

### Inspecting what happened

The returned object exposes live views you read after the action under test runs:

```ts
await someHandler(req, res);

// Every cross-plugin tool dispatch, in order.
expect(mock.toolCalls[0]).toMatchObject({
  plugin: "analytics",
  tool: "query",
  asUser: true, // proves the on-behalf-of path ran
});

// Every route the plugin registered (raw handlers, before wrapping).
expect(mock.routes).toContainEqual(
  expect.objectContaining({ method: "post", path: "/invocations" }),
);

// The injected telemetry provider, for span assertions.
expect(mock.telemetry.getTracer().startActiveSpan).toHaveBeenCalled();
```

`RecordedToolCall.asUser` is the high-value signal: it confirms the context routed the call through the user's identity rather than the service principal — a distinction that silent stubs cannot verify.

## `expectStream(...)`

AppKit plugins stream Server-Sent Events. `expectStream` consumes a stream and asserts the ordered event types it emits. It accepts an async iterable (an agent adapter's `run()`), a plain array of events, or an SSE `Response` (or a promise of one) whose body it parses.

```ts
import { expectStream } from "@databricks/appkit/testing";

// In-order subsequence match — interleaved events (heartbeats, deltas) are ignored.
await expectStream(agent.adapter.run(input)).toEmit("tool_call", "message_delta");

// Exact match — the stream's full shape, in order, with nothing else.
await expectStream(events).toEmitExactly("warehouse_status", "result");

// Or collect without asserting.
const types = await expectStream(res).collectTypes();
```

`toEmit` checks that the expected types appear **in order** but tolerates other events before, between, or after them — which is what you want for streams that interleave bookkeeping events like heartbeats or metadata. Use `toEmitExactly` when the stream's shape is fully determined.

## Fixtures

The kit re-exports the request/response/context fixtures AppKit uses internally:

- `createMockRequest(overrides?)` / `createMockResponse()` — Express request/response doubles, including the streaming flags (`headersSent`, `writableEnded`) and a mock `WorkspaceClient`.
- `mockServiceContext(options?)` — spy the `ServiceContext` singleton so code that resolves the service principal or a user context gets test doubles. Call in `beforeEach`, and call the returned `restore()` in `afterEach`.
- `createSuccessfulSQLResponse(rows, columns)` / `createFailedSQLResponse(message)` — build SQL Warehouse statement responses.
- `setupDatabricksEnv(overrides?)` — set `DATABRICKS_HOST` / `DATABRICKS_WAREHOUSE_ID` to test values.

## Full example

```ts
import { describe, expect, test } from "vitest";
import { analytics } from "@databricks/appkit";
import {
  createMockRequest,
  createMockResponse,
  mockPluginContext,
} from "@databricks/appkit/testing";

describe("analytics query route", () => {
  test("streams warehouse status then the result", async () => {
    const mock = mockPluginContext({
      analytics: { top_users: [{ user: "alice", events: 42 }] },
    });
    const plugin = analytics({});
    await mock.attach(plugin);

    const req = createMockRequest({
      params: { query_key: "top_users" },
      body: { format: "JSON_ARRAY" },
    });
    const res = createMockResponse();

    await plugin._handleQueryRoute(
      req as never,
      res as never,
    );

    expect(res.status).not.toHaveBeenCalledWith(500);
  });
});
```

## See also

- [Local development](./local-development.mdx) — run your app with hot reload while iterating.
- [Custom plugins](../plugins/custom-plugins.md) — build the plugins you test with this kit.
- [Execution context](../plugins/execution-context.md) — how `asUser` and the service principal differ at runtime.
