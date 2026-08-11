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

The kit uses [Vitest](https://vitest.dev)'s `vi` for its mocks, so `vitest` is a peer dependency and must be installed to import from this subpath. Any project that runs Vitest as its test runner already has it — AppKit apps scaffolded from the template do — so in practice there is nothing extra to add.

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
const plugin = new MyAgentPlugin({ dir: false });
await mock.attach(plugin);
```

Instantiate the plugin **class** directly (`new MyAgentPlugin(...)`). The `analytics()` / `agents()` factories you pass to `createApp` return a descriptor for the app to construct — for a unit test you want the instance.

The cache `attach()` seeds is a process-wide singleton: `CacheManager` is initialized once per test process and reused. Vitest isolates test *files* in separate workers, so caches never leak across files, but tests **within one file** share it. If a test populates the cache and a later test in the same file must not see it, reset between tests (e.g. clear the cache in `beforeEach`).

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

// The injected telemetry provider records the context's own spans — i.e. the
// span PluginContext.executeTool opens around each cross-plugin tool call.
expect(mock.telemetry.getTracer().startActiveSpan).toHaveBeenCalled();
```

`mock.telemetry` is injected into the `PluginContext`, so it captures the spans the *context* opens (notably `executeTool`). It is **not** the plugin's own telemetry: `attachContext` rebuilds `this.telemetry` from the real `TelemetryManager`, so spans a plugin opens internally do not land on `mock.telemetry`.

`RecordedToolCall.asUser` is the high-value signal for cross-plugin calls: because the fake `asUser` enforces the same token precondition as the real `Plugin.asUser`, a dispatch that records `asUser: true` (with `userId` set) genuinely resolved the caller's user scope, and a request missing `x-forwarded-access-token` **rejects** instead — the OBO distinction that silent `{ executeTool }` stubs cannot verify. Assert both directions: a well-formed request records the expected `userId`, and a token-less one throws.

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

Instantiate the plugin **class** directly with `new`. The `analytics()` / `agents()` factory functions you pass to `createApp` return a descriptor for the app to construct — for a unit test you want the instance itself.

```ts
import { Plugin, type PluginManifest } from "@databricks/appkit";
import { expectStream, mockPluginContext } from "@databricks/appkit/testing";
import { describe, expect, test } from "vitest";

// A small plugin that registers a route and streams two events.
class GreeterPlugin extends Plugin {
  static manifest = {
    name: "greeter",
    displayName: "Greeter",
    description: "Example plugin",
    resources: { required: [], optional: [] },
  } as PluginManifest<"greeter">;

  async setup() {
    this.context?.addRoute("get", "/hello", (_req, res) => res.end());
  }

  async *greet(name: string) {
    yield { type: "greeting_start", name };
    yield { type: "greeting_end", message: `Hello, ${name}!` };
  }
}

describe("greeter plugin", () => {
  test("registers its route through the context", async () => {
    const mock = mockPluginContext();
    const plugin = new GreeterPlugin({});

    await mock.attach(plugin);
    await plugin.setup();

    expect(mock.routes).toContainEqual(
      expect.objectContaining({ method: "get", path: "/hello" }),
    );
  });

  test("streams events in order", async () => {
    const plugin = new GreeterPlugin({});
    await expectStream(plugin.greet("world")).toEmit(
      "greeting_start",
      "greeting_end",
    );
  });
});
```

To test a plugin that dispatches cross-plugin tool calls, register fake providers and assert on `mock.toolCalls` — including `asUser`, which confirms the on-behalf-of path ran:

```ts
const mock = mockPluginContext({ analytics: { query: [{ n: 1 }] } });
const plugin = new MyAgentPlugin({ dir: false });
await mock.attach(plugin);

await plugin.runSomethingThatCallsAnalytics(req);

expect(mock.toolCalls[0]).toMatchObject({
  plugin: "analytics",
  tool: "query",
  asUser: true,
});
```

## See also

- [Local development](./local-development.mdx) — run your app with hot reload while iterating.
- [Custom plugins](../plugins/custom-plugins.md) — build the plugins you test with this kit.
- [Execution context](../plugins/execution-context.md) — how `asUser` and the service principal differ at runtime.
