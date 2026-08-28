---
sidebar_position: 10
---

# Testing

AppKit ships a testing kit at `@databricks/appkit/testing` so you can test a plugin, including its cross-plugin tool calls and streaming responses, without a live Databricks workspace, credentials, or network access. Plugin tests stay fast and run in CI, where no workspace is available.

## Goal

Exercise a plugin's real code paths against a real `PluginContext` with only its outer edges faked. That covers route registration, cross-plugin tool dispatch, user-scoped (on-behalf-of) execution, and per-call timeouts. Nothing about the context is reimplemented, so a test can't drift from production behavior.

The kit has three entry points plus a set of fixture helpers:

- **`createTestApp({ plugins })`** — boot a real app and call it over real HTTP. Start here.
- **`createTestPluginContext()`** — build a real `PluginContext` with faked edges and attach it to a plugin, with no boot and no socket.
- **`expectStream(...).toEmit(...)`** — assert the ordered event types a stream emits.
- **Fixtures** — `createMockRequest`, `createMockResponse`, `createMockWorkspaceClient`, `mockServiceContext`, and SQL response builders.

`vitest` is an **optional peer dependency**: the kit's mocks use its `vi` and resolve against your installed copy. Apps that never import `@databricks/appkit/testing` don't install it, so production stays free of the test framework. Any Vitest v3 or v4 works.

## Testing your plugin

`createTestApp({ plugins })` boots a **real** AppKit app, with the real Express wiring, routes, and resource validation, then hands you methods to call it like a client would:

```ts
import { createTestApp, expectStream } from "@databricks/appkit/testing";

test("my plugin answers a request", async () => {
  const app = await createTestApp({ plugins: [myPlugin()] });
  try {
    const res = await app.post("/api/my-plugin/thing", { body: { q: 1 }, obo: true });
    expect(res.status).toBe(200);
    await expectStream(res).toEmit("status", "result");
  } finally {
    await app.close();
  }
});
```

No workspace, no credentials, no network. The harness pins a non-development `NODE_ENV`, binds an ephemeral port, installs a fake workspace client, and keeps the cache in memory so nothing reaches out.

Paths are the full mounted route. A plugin's prefix is `/api/` plus its manifest name in kebab-case, so a plugin named `mySearch` serves at `/api/my-search/…`.

### Which harness?

| | `createTestApp` | `createTestPluginContext` |
| --- | --- | --- |
| Boots the app | Yes | No |
| Binds a socket | Yes (ephemeral port) | No |
| Express middleware, error handler | Real | Not involved |
| Resource / env validation | Real, and strict | Not involved |
| Workspace client | Faked and injected | Fake it yourself with `mockServiceContext` |
| Needs `close()` | **Yes** | No |
| Speed | Fast, but pays for a socket | Fastest |

Use `createTestApp` for a plugin's HTTP behavior end to end. Use `createTestPluginContext` to unit-test wiring: route registration, tool dispatch, timeout composition. Name harness suites `*.integration.test.ts`, matching the existing convention.

### Faking what your plugin reads

Declare responses by dotted path — `"<service>.<method>"` on AppKit's workspace-client facade:

```ts
const app = await createTestApp({
  plugins: [myPlugin()],
  responses: {
    "jobs.getRun": { state: "TERMINATED", result_state: "SUCCESS" },
    "statementExecution.executeStatement": { status: { state: "SUCCEEDED" } },
    "apiClient.request": { results: [] },
  },
});
```

A function value receives the call arguments, so you can script per-argument behavior or reject to test an error path. `responses` configures the built-in mock, so passing it alongside your own `client` is rejected rather than silently ignored — configure the responses on that client instead. Any path you **don't** declare resolves `undefined` rather than crashing — see [Mocking Databricks services](#mocking-databricks-services).

For the response *shapes*, follow the service types on the Databricks SDK. The kit doesn't validate them, so a wrong shape fails in your plugin, not in the fake.

With one app open, `app.client` is the very object your handler resolves at runtime — reached inside a plugin via `getExecutionContext().client` — so you can assert calls on it:

```ts
import { getMock } from "@databricks/appkit/testing";

expect(getMock(app.client, "jobs.getRun")).toHaveBeenCalledWith({ run_id: 42 });
```

Facade accessors are typed against the SDK, so `expect(app.client.jobs.getRun).toHaveBeenCalled()` won't typecheck — `getMock` reaches the underlying spy.

### Requests

`app.get/post/put/patch/delete(path, options?)` return a native `Response`, so `expectStream` composes directly with no bridge.

- `body` — a non-string value is JSON-encoded with `content-type: application/json`. A string is sent as-is.
- `headers` — merged last, so they win over anything the harness set.
- `obo` — `true` for the default test user, or `{ userId, token, email }`. Same shorthand as `createMockRequest({ obo })`, so a handler using `asUser(req)` resolves that identity.
- `signal` — forwarded to `fetch`.

### Teardown

The harness binds a socket and installs signal handlers, so **every boot needs a `close()`**. It releases the socket, runs your plugin's `shutdown()` hooks, drops AppKit's singletons, and restores `process.env` to its pre-boot state. It's idempotent.

Prefer `await using`, which closes the app at scope exit even if the test throws:

```ts
await using app = await createTestApp({ plugins: [myPlugin()] });
// released at scope exit
```

`try/finally` works too, and is what you need if the app has to outlive a block:

```ts
const app = await createTestApp({ plugins: [myPlugin()] });
try {
  // ...
} finally {
  await app.close();
}
```

Miss the close and each boot leaks a listener; Node warns at about six.

### Satisfying declared resources

The harness runs the real validator with a strict posture, so a plugin whose manifest requires a resource fails the boot unless its env var is set. Supply it with `env`:

```ts
// Throws: MY_WAREHOUSE_ID is required by the manifest.
await createTestApp({ plugins: [myPlugin()] });

// Boots.
await createTestApp({ plugins: [myPlugin()], env: { MY_WAREHOUSE_ID: "w-1" } });
```

That makes "my plugin declares its resources correctly" a genuine assertion. `env` is restored on `close()`.

:::note What this does not check
The harness validates that required resources' **environment variables are present**. It does **not** validate config *values* against your manifest's `config.schema` — no runtime validator exists for that yet. A test that boots successfully tells you your resource declarations and env are wired up; it says nothing about whether your config values are well-formed.
:::

### Other options

- `server: false` — no socket. Plugin setup, validation, and teardown still run; the request methods throw if called. Useful when you only care that a plugin boots.
- `client` — supply your own workspace client instead of the built-in fake. You then own its `currentUser.me()`: AppKit reads `currentUser.id` during boot and can't start without it.
- `nodeEnv` — defaults to `"test"`. `"development"` is **refused**: dev mode routes the harness's ephemeral port through `get-port`, which throws on port `0`, and it also boots a real Vite server and relaxes validation.
- `cache` — defaults to in-memory. Override it only when reaching the network is the point of the test.
- `closeTimeoutMs` — teardown budget.

## `createTestPluginContext()`

`PluginContext` is the mediator AppKit passes to every plugin: it buffers routes, tracks tool providers, and runs cross-plugin tool calls with user scoping and a timeout. `createTestPluginContext()` returns the **real** context with three edges faked:

| Edge | How it's faked |
| --- | --- |
| Telemetry | A no-op mock provider — no OpenTelemetry pipeline needed. |
| Tool providers | Fakes registered through the real `registerToolProvider`, keyed by plugin then tool name. |
| Routes | The real `addRoute`/`addMiddleware` are wrapped to record what a plugin registers. |

The context is real, so `executeTool` runs the actual user-scope (`asUser(req)`) and timeout-composition paths — not stubs of them.

### Registering fake tool responses

Pass canned responses keyed by plugin name, then tool name. A response is either a static value or a function of the call arguments and the composed abort signal:

```ts
import { createTestPluginContext } from "@databricks/appkit/testing";

const mock = createTestPluginContext({
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
const plugin = new MyAgentPlugin({});
await mock.attach(plugin);
```

Instantiate the plugin **class** directly (`new MyAgentPlugin(...)`). The `analytics()` / `agents()` factories you pass to `createApp` return a descriptor for the app to construct — for a unit test you want the instance.

### Seeding with workspace responses and environment

`createTestPluginContext` accepts a second `options` parameter to control the faked workspace client and environment:

```ts
const mock = createTestPluginContext({}, {
  responses: {
    "jobs.getRun": { state: "TERMINATED" },
    "servingEndpoints.query": (args, signal) => runFakeQuery(args),
  },
  env: { MY_VAR: "test-value" },
  strict: true,
});

// The factory call is synchronous; attach is the async part.
await mock.attach(plugin);
```

`options` is:
- `responses` — seed the mock workspace client with responses keyed by dotted path (`"jobs.getRun"`, `"genie.getMessage"`). A value can be static or a function of call arguments and the abort signal.
- `env` — set environment variables scoped to the test; they are restored on plugin detach.
- `strict` — throw if a handler calls an undeclared workspace-client path (instead of silently resolving `undefined`). The built-in defaults still count as declared.

The context installs a test-scoped service context via `beforeEach` and restores it on `afterEach`, so it survives across tests in the same suite. Call the returned `.restore()` explicitly if you need to clear it mid-test.

The workspace client and on-behalf-of stub are process-wide too: `ServiceContext` holds one client, and the `createUserContext` fake is a single spy. So **`createTestApp` allows one open app at a time** and throws if you boot a second before closing the first. Vitest isolates test *files* in separate workers, so this constrains only apps within one file — and a `describe` holding an app open in `beforeAll` can't contain a test that boots its own.

The cache is a process-wide singleton too — initialized once per test process and shared by tests **within one file** (it never leaks across files). If one test populates it and a later one must not see that, clear between tests with `resetTestCache()`:

```ts
import { resetTestCache } from "@databricks/appkit/testing";

beforeEach(async () => {
  await resetTestCache(); // no-op if the cache isn't initialized yet
});
```

It also helps *within* a single test — clear the cache to force a miss, then assert the following call is a hit.

### Asserting cache behaviour

When a plugin caches its work (like `analytics` caching query results), test the caching *itself* — a second identical call is a hit, different users get different keys — with `useTestCache()`. It boots the real in-memory cache, clears it before each test, and hands back the real `CacheManager`, so you assert against production's own `getOrExecute` and `generateKey` rather than mocking the internal `cache` module:

```ts
import { useTestCache } from "@databricks/appkit/testing";

describe("my plugin caches", () => {
  const testCache = useTestCache();

  test("a second identical request is served from cache", async () => {
    const plugin = new MyPlugin(config);
    // ...drive the same request twice against a mocked downstream call...
    expect(downstreamMock).toHaveBeenCalledTimes(1);
  });

  test("scopes the cache key per user", () => {
    const a = testCache.current.generateKey(["query", sql], "user-1");
    const b = testCache.current.generateKey(["query", sql], "user-2");
    expect(a).not.toBe(b);
  });
});
```

Call it at the top of a `describe` (or module top-level), not inside a test — Vitest registers its `beforeEach`/`afterEach` at collection time. It boots the cache before each test, so a plugin you construct binds `this.cache` to the real cache and runs its actual caching path. Use `resetTestCache()` (above) instead when you only need to clear the cache, not a handle to it.

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

Assert cross-plugin on-behalf-of through `RecordedToolCall.asUser`. The fake `asUser` enforces the real `Plugin.asUser`'s token precondition: a request carrying a forwarded token records `asUser: true` with the resolved `userId`, and one missing `x-forwarded-access-token` **rejects**. Assert both directions — a well-formed request records the expected `userId`, a token-less one throws. A silent `{ executeTool }` stub verifies neither.

The fake replicates `asUser`'s **token precondition**, not its internal dev-mode telemetry marker: in `NODE_ENV=development` the real `Plugin.asUser` skips impersonation and sets an OTel `isDevOboFallback()` flag, which the fake does not reproduce. Assert OBO through the recorded `asUser`/`userId` fields rather than `isDevOboFallback()`.

## `expectStream(...)`

AppKit plugins stream Server-Sent Events. `expectStream` consumes a stream and asserts the ordered event types it emits. It accepts an async iterable (an agent adapter's `run()`), a plain array of events, an SSE `Response` (or a promise of one) whose body it parses, or a `createMockResponse()` whose captured writes it replays.

```ts
import { expectStream } from "@databricks/appkit/testing";

// In-order subsequence match — interleaved events (heartbeats, deltas) are ignored.
await expectStream(agent.adapter.run(input)).toEmit("tool_call", "message_delta");

// Exact match — the stream's full shape, in order, with nothing else.
await expectStream(events).toEmitExactly("warehouse_status", "result");

// Or collect without asserting.
const types = await expectStream(res).collectTypes();
```

### Asserting a plugin's streaming route

Most plugins stream SSE from a **route handler** (`res.write(...)`), not a bare generator. `createMockResponse()` captures those writes, and `expectStream` reads them straight back — drive the real handler, then assert:

```ts
import { createMockRequest, createMockResponse, expectStream } from "@databricks/appkit/testing";

const res = createMockResponse();
await plugin._handleStream(createMockRequest({ obo: true }), res);

// The mock captured the SSE the handler wrote; expectStream parses it.
await expectStream(res).toEmit("status", "result");
```

`expectStream(res)` and `expectStream(res.sseResponse())` are equivalent; the latter hands you the raw `Response` if you want it. Do **not** pass the SSE body as a string: a string is an iterable of characters, so `expectStream` rejects it with a pointer to `sseResponse()` rather than emitting one "event" per character.

`toEmit` checks that the expected types appear **in order** but tolerates other events before, between, or after them — which is what you want for streams that interleave bookkeeping events like heartbeats or metadata. Use `toEmitExactly` when the stream's shape is fully determined.

`expectStream` buffers the whole source before asserting, so a stream that never terminates would otherwise hang until the test runner's own timeout. Pass `{ timeout }` to fail fast with a clear error instead:

```ts
await expectStream(handler.stream(req), { timeout: 1000 }).toEmit("result");
```

## Fixtures

AppKit has two contexts, and they're faked by different tools. `PluginContext` is the mediator between plugins, handling routes, tool dispatch, and user scoping; `createTestPluginContext()` gives you the real thing with faked edges. `ServiceContext` is the **data plane**: it resolves the workspace client, the service principal, and the warehouse ID that plugins reach through `getWorkspaceClient()`.

The kit covers both. `createTestApp` fakes the data plane by injecting a mock workspace client at the real seam; below that, `mockServiceContext` spies the singleton directly, and `createMockWorkspaceClient` builds the client either of them installs.

The kit re-exports the request/response/context fixtures AppKit uses internally:

- `createMockRequest(overrides?)` / `createMockResponse()` — Express request/response doubles, including the streaming flags (`headersSent`, `writableEnded`). Pass `obo: true` (or `obo: { userId, token, email }`) to set the forwarded identity headers `asUser` requires, instead of hand-adding them. `createMockResponse()` also captures everything a handler writes; pass it to `expectStream` (or call `sseResponse()`) to assert a streaming route's SSE. (Plugins resolve the workspace client through `getWorkspaceClient()`, not the request — use `mockServiceContext` to control it.)
- `createMockRouter()` — build a mock Express-style router for testing route-registration wiring.
- `mockServiceContext(options?)` — spy the `ServiceContext` singleton so code that resolves the service principal or a user context gets test doubles. Call in `beforeEach`, and call the returned `restore()` in `afterEach`.
- `useServiceContextMock(options?)` — the same, in one line: it registers the `beforeEach` install and `afterEach` restore for you. Call it at the top of a `describe` block (not inside a test), and read the live `.current` handle from within a test:
  ```ts
  describe("my plugin", () => {
    const ctx = useServiceContextMock();
    test("...", async () => {
      await handler(createMockRequest({ obo: true }), res);
      expect(ctx.current.createUserContextSpy).toHaveBeenCalled();
    });
  });
  ```
- `createSuccessfulSQLResponse(rows, columns)` / `createFailedSQLResponse(message)` — build SQL Warehouse statement responses.
- `setupDatabricksEnv(overrides?)` — set `DATABRICKS_HOST` / `DATABRICKS_WAREHOUSE_ID` to test values.
- `withEnv(vars, fn)` — set environment variables for the duration of a sync or async function, restoring each key's prior state (or deleting it if it was previously unset). Unlike a bare `process.env.X = ...` followed by `delete`, nested calls restore LIFO and don't accidentally leave prior values in place.
  ```ts
  // Before: process.env.X = "test"; try { /* code */ } finally { delete process.env.X }
  // After:
  await withEnv({ X: "test" }, async () => { /* code */ });
  ```
- `createApiError({ statusCode, message, errorCode })` — create a genuine `ApiError` instance for testing error paths. Returns an instance where `error instanceof ApiError` holds, so your error handling resolves the right type.
  ```ts
  const error = createApiError({ statusCode: 404, message: "Not found", errorCode: "NOT_FOUND" });
  expect(error instanceof ApiError).toBe(true);
  ```
- `resetTestCache()` — clear the shared cache singleton between (or within) tests; no-ops if the cache isn't initialized yet.
- `resetGlobalState()` — drop AppKit's process-wide singletons so a later `createApp` builds fresh ones. `createTestApp`'s `close()` already does this; you need it only if you call `createApp` yourself. Close first, then reset — it drops pointers, it doesn't release resources.
The kit uses both words deliberately: a **mock** records calls so you can assert on them (`createMockWorkspaceClient`, `mockServiceContext`), while a **fake** stands in and simply works (`FakeProvider`, `FakeToolResponse`).

- `createTestPlugin(factory, config?)` — instantiate a plugin from its factory with the same config merge AppKit applies. See [Full example](#full-example).
- `getListeningPort(server)` — wait for a server to finish binding and return the port it landed on. `createTestApp` does this for you; reach for it when you start a server yourself with `port: 0`.

## Mocking Databricks services

Every core plugin's real work goes through `getWorkspaceClient()`. `createMockWorkspaceClient()` fakes that whole surface, so a plugin touching `jobs`, `genie`, `servingEndpoints`, or `files` is testable without hand-building a nested client:

```ts
import { createMockWorkspaceClient, getMock } from "@databricks/appkit/testing";

const client = createMockWorkspaceClient({
  responses: { "jobs.getRun": { state: "TERMINATED" } },
  config: { host: "https://my-test-host.example.com" },
});

await client.jobs.getRun({ run_id: 1 });        // → { state: "TERMINATED" }
await client.genie.getMessage({ id: "m-1" });   // → undefined, does not throw
```

`createTestApp` installs one of these for you, so reach for it directly only when you're driving a plugin through `createTestPluginContext` or `mockServiceContext`.

How it works, and what to expect:

- The **facade is typed**, so `client.jbos` is a compile error. AppKit owns the interface, so it's a closed set, not an open-ended chase of the SDK.
- Each **service** is a proxy that mints a memoized mock per method. `client.jobs.getRun === client.jobs.getRun`, so call assertions are stable, and `toLegacyWorkspaceClient()` shares the same functions — one `responses` entry covers both views.
- `config.host` is a real **string** (not a mock), because AppKit builds URLs from it. `apiClient.userAgent()` is synchronous for the same reason, and `apiClient.request` resolves `{}` so destructuring its result doesn't throw.
- Sensible defaults are built in: SQL statements succeed, warehouses report `RUNNING`, and `currentUser.me()` returns a service user. Pass `defaults: false` to script everything yourself.

:::caution Undeclared methods return undefined
An undeclared method resolves `undefined` instead of throwing. That's the point — your plugin survives touching services the test doesn't care about — but it means a call whose response you *forgot* to declare silently returns `undefined` rather than failing loudly, so a test can pass for the wrong reason.

Pass `strict: true` to turn that silence into a failure: a call to a path with no declared response throws instead of resolving `undefined`, naming the path. The canned defaults still count as declared, so a harness boot works unchanged.

```ts
const app = await createTestApp({ plugins: [myPlugin()], strict: true });
// a handler calling an undeclared path now fails the request
```

TypeScript catches more than the obvious: each accessor is typed against the SDK's own service class, so both a misspelled **service** (`client.jbos`) and a misspelled **method** (`client.jobs.getRunz`) are compile errors. The gap is a *real* method with no declared response — and any call that bypasses the types with a cast.

One more divergence: a service's methods are minted on access, so they are **callable but not enumerable**. `typeof client.jobs.getRun` is `"function"`, but `'getRun' in client.jobs` is `false` and `Object.keys(client.jobs)` is `[]`. Plugin code that feature-detects with `in` or reflects over a service will therefore take a different branch than in production. That's deliberate — reporting the keys would make `util.inspect` probe each one, minting a mock per probe.

Separately, `createLakebasePool({ workspaceClient })` will build a pool whose password callback resolves to a mock: the pool exists but cannot connect. A Lakebase test needs a real database or a purpose-built fake pool, not this.
:::

## Full example

For a plugin you wrote, instantiate the class directly with `new`. The `analytics()` / `agents()` factory functions you pass to `createApp` return a *descriptor* for the app to construct, not an instance.

When you want an instance from one of those factories, use `createTestPlugin` rather than reaching through the descriptor:

```ts
import { createTestPlugin } from "@databricks/appkit/testing";

const plugin = createTestPlugin(genie, { spaceId: "s-1" });

// Not this — it skips DEFAULT_CONFIG and forgets `name`, so the instance is
// configured differently from the one production builds:
//   const plugin = new (genie({}).plugin)({ spaceId: "s-1" });
```

`createTestPlugin` applies the same merge AppKit does at registration: `DEFAULT_CONFIG`, then your config, then the manifest `name`. It's for this unit-test path only — `createTestApp` takes descriptors and builds the instances itself.

```ts
import { Plugin, type PluginManifest } from "@databricks/appkit";
import { expectStream, createMockRequest, createTestPluginContext } from "@databricks/appkit/testing";
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
    const mock = createTestPluginContext();
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
const mock = createTestPluginContext({ analytics: { query: [{ n: 1 }] } });
const plugin = new MyAgentPlugin({});
await mock.attach(plugin);

// `obo` sets the forwarded identity headers `asUser` needs — without them the
// dispatch would (correctly) reject with "Missing user token".
const req = createMockRequest({ obo: true });
await plugin.runSomethingThatCallsAnalytics(req);

expect(mock.toolCalls[0]).toMatchObject({
  plugin: "analytics",
  tool: "query",
  asUser: true,
});
```

## See also

- [Custom plugins](./custom-plugins.md) — build the plugins you test with this kit.
- [Execution context](./execution-context.md) — how `asUser` and the service principal differ at runtime.
- [Local development](../development/local-development.mdx) — run your app with hot reload while iterating.
