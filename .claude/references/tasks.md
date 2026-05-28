# Durable Task Best Practices

Reference guide for using the durable task service inside AppKit plugins. The built-in **durable execution service** is opt-in: enable it with `createApp({ task: true })` or an explicit `task` config. When it is not enabled, plugin `this.task` is `null`; `this.executeTask` exists on `Plugin` but throws until durable execution is enabled.

Every guideline is prefixed with a severity tier:

- **NEVER** — Security, correctness, or breakage blocker. Violating this corrupts state, double-charges users, or loses durability guarantees.
- **MUST** — Correctness requirement. Violating this produces bugs, broken recovery, or inconsistent behavior.
- **SHOULD** — Quality recommendation. Violating this degrades DX, performance, or maintainability.

> **Scope:** the task service used from inside core or custom AppKit plugins (`packages/appkit/src/plugins/` or external). For the underlying engine architecture, see the upstream engine repo's `docs/ARCHITECTURE.md` and `docs/ONE_PAGER.md`.

**Imports.** AppKit surfaces task types and helpers from `@databricks/appkit` (for example `step`, `TaskDefinition`, `TypedTaskContext`, `TaskContext`, `TASK_IDEMPOTENCY_HEADER`, `setupSseHeaders`, `writeSseFrame`). The vendored native engine lives under `packages/appkit/vendor/taskflow/`; do not import the vendored `Taskflow` facade from that path inside plugins — use `this.task` instead.

---

## 1. When to Use Durable Tasks

The decision is binary. Reach for it when **at least one** of these is true:

- Operation runs longer than ~5 seconds and the user/client expects to see progress.
- Re-running from scratch on crash is **incorrect** (side effects already persisted) or **expensive** (compute, money, time).
- The operation must survive process restart (rolling deploy, crash, host reclaim).
- Multiple steps each have their own success/failure semantics that need to be tracked.

**MUST** use `this.executeTask(res, name, input, settings?)` — not `this.execute()` — for any operation matching the above. Do not try to reinvent durability with the `retry` interceptor plus ad-hoc disk writes.

**MUST NOT** use it for sub-second reads, stateless transformations, or fire-and-forget logging. The WAL append cost is small but the conceptual overhead (task naming, idempotency keys, recovery) is not. Use `this.execute()` with retry/cache/timeout interceptors instead.

| Method | Latency budget | Crash survival | Use when |
|---|---|---|---|
| `this.execute(fn, settings)` | < 5s typical | None | Read with retry/cache/timeout |
| `this.executeStream(res, gen, settings)` | seconds to minutes | None | Live progress; loss-on-crash acceptable |
| `this.executeTask(res, name, input, settings?)` | seconds to hours | Full | Anything you would be sad to re-run from scratch |

---

## 2. Task Registration

**MUST** register every durable task in `setup()`, never in `injectRoutes()` or constructors. `setup()` runs once after plugins boot; route handlers run per request.

**MUST** pass a single **`TaskDefinition`** object to `this.task.task(definition)`. The shipped shape is `{ name, execute, recover?, autoRecover? }`, not separate positional arguments.

```typescript
import type { TypedTaskContext } from "@databricks/appkit";

async setup() {
  this.task.task({
    name: "agent-loop",
    execute: (input, ctx) => this.runAgentLoop(input, ctx),
    recover: (input, ctx) => this.recoverAgentLoop(input, ctx),
    autoRecover: true,
  });
  this.task.task({
    name: "export-data",
    execute: (input, ctx) => this.exportData(input, ctx),
    autoRecover: true,
  });
}
```

**MUST** use lowercase kebab-case (or a consistent colon-separated prefix convention such as `my-plugin:query`) for the `name` field. The string you pass is the task name the engine stores; AppKit does not auto-prefix it. Multiple plugins should choose names that do not collide.

**NEVER** register the same `name` twice expecting two handlers. The service **warns** and the new registration **replaces** the previous one; recovery and routing become confusing.

**NEVER** change a task's `name` across releases without a migration plan. Names are persisted in the WAL — renaming orphans in-flight tasks across deploy.

**MUST** understand `autoRecover`: the service records `definition.autoRecover ?? true`. So **`true` is the default for all tasks**, including OBO tasks. There is no special default that flips off for OBO. For OBO workloads, you **MUST** set `autoRecover: false` yourself: the recovery worker has no `UserContext`, so automatic recovery will break `asUser`-style calls after restart.

**MUST** treat the runtime warning in `executeTask` honestly: if you register an OBO task with `autoRecover: true` (explicitly or by default), AppKit logs a **once-per-(plugin,task)** warning that recovery after restart will run without the original `UserContext`. That is guidance, not a change to the default — **fix the registration** (`autoRecover: false` + explicit `resume`) rather than relying on the warning.

**SHOULD** provide `recover` when re-running `execute` from scratch would be expensive or unsafe. Without `recover`, the engine may still re-invoke the handler on recovery per engine semantics; `recover` is your typed hook when you need custom resumption logic.

**SHOULD** use `this.task.task<Input, Output, Events>({ ... })` with a third generic (`Events`) so `ctx.emit` is tied to a known event map — the same names and payload shapes are what the SSE bridge exposes to clients.

---

## 3. Idempotency Keys

The engine derives each task's idempotency key (IK) from the **task name**, a **canonical form of the input**, and the **submit-time `userId`** (from the active user context when OBO, or absent for service-principal runs). Plugin code does **not** pass an IK override through `executeTask` — `ExecuteTaskSettings` has no `idempotencyKey` field.

**MUST** treat the IK as the **identity of the logical task**. Duplicate submits with the same name + input + owner dedupe per the engine's `executeMode` (`SubmitOptions`).

**MUST** design `input` so that everything that should distinguish two logical runs is **on the input object**. Example: the analytics plugin includes `queryKey`, statement, parameters, executor key, and format discriminator so distinct client operations do not collide.

**SHOULD** return the IK to clients when they need reconnect or `/resume` / `/stop` follow-ups. The `executeTask` bridge sets the HTTP header **`TASK_IDEMPOTENCY_HEADER`** (`"X-AppKit-Task-Idempotency-Key"`) and sends an initial SSE frame `event: ready` with `data: {"idempotencyKey":...}` so cross-origin `EventSource` clients that cannot read headers still get the key. Import `TASK_IDEMPOTENCY_HEADER` from `@databricks/appkit` if you read it in middleware or tests.

**NEVER** assume you can forge ownership by passing a user id from the client. `ExecuteTaskSettings` explicitly forbids a `userId` field (`never`) — identity comes only from `runInUserContext` / `asUser(req)`.

**NEVER** fold attempt counters, retry numbers, or timestamps into inputs when they would change what should be the **same** logical task — that creates accidental IK churn. Conversely, do not omit fields from input that should separate two runs.

**SHOULD** switch the storage backend for real multi-pod deployment: if the runtime looks like **Databricks Apps** (`DATABRICKS_APP_NAME`, `DATABRICKS_APP_ID`, or `DATABRICKS_APP_URL`) and you still use the default **SQLite** backend, AppKit logs a **WARN** that tasks will not survive rolling restarts; plan for **`lakebase`** (Postgres) or another shared backend via `createApp({ task: { storage: … } })`.

---

## 4. Handler Signature

The handler signature is fixed on `TaskDefinition.execute`:

```typescript
execute(input: TInput, ctx: TypedTaskContext<TEvents>): Promise<TResult>
```

**`ctx` provides** (engine `TaskContext`, narrowed for `emit` when you use `TypedTaskContext`):

| Field | Type | Use |
|---|---|---|
| `ctx.emit(name, payload)` | `(string, unknown) => Promise<void>` | Append a user event; becomes SSE after bridge rules below |
| `ctx.isRecovery` | `boolean` | `true` if this invocation is a recovery path |
| `ctx.previousEvents` | `TaskEvent[]` | Historical events for this task; inspect in recovery |
| `ctx.context` | `unknown \| null` | Live sidecar (e.g. `UserContext`); **not** persisted across crash |
| `ctx.idempotencyKey` | `string` | IK for this task |
| `ctx.attempt` | `number` | Attempt counter |
| `ctx.taskId`, `ctx.userId`, `ctx.heartbeat()` | … | See engine types in `task.d.ts` |

**MUST** treat the handler as a function that may run in another process after failure. Durable state must come from `input`, `ctx.previousEvents`, or external storage — not from closures that assume a single long-lived Node process.

**MUST** branch on `ctx.isRecovery` when semantics differ after restart.

**MUST** await every `ctx.emit()` call.

**MUST** when reading `ctx.previousEvents`, compare against engine **`eventType` strings as stored**, not the short names you passed to `emit`. User emits are persisted with a **`custom:`** prefix — e.g. `ctx.emit("tick", …)` produces `eventType: "custom:tick"`. The **`executeTask` SSE bridge strips `custom:` for frames sent to the client**, but **`previousEvents` in the handler still use the prefixed form.**

**NEVER** emit custom events whose **short name** (after `custom:` is stripped for wire purposes) matches any reserved bridge or terminal name. If you `ctx.emit` one of these, the bridge **logs a warning and drops** the frame so clients do not get misleading terminal or control events:

- `ready`, `error`, `heartbeat`, `completed`, `failed`, `cancelled`, `suspended`

Choose alternatives such as `task_completed` or `query_tick`.

**SHOULD** keep payloads JSON-friendly. The bridge serialises with `JSON.stringify` and a **BigInt** replacer (values become **decimal strings** on the wire) so warehouse `LONG`/`BIGINT` columns do not throw at serialisation time.

---

## 5. The `step()` Helper (Not a Decorator)

AppKit exports **`step`** as a **higher-order function** from `@databricks/appkit`. There is **no** `@step` decorator on `Plugin`.

```typescript
import { step } from "@databricks/appkit";

const fetchInvoices = step(async (ctx, accountId: string) => {
  return this.invoiceClient.list({ accountId });
});

// Inside this.task.task({ execute: async (input, ctx) => { ... } })
const rows = await fetchInvoices(ctx, input.accountId);
```

**Semantics:**

- **`step(fn)` returns a memoised wrapper.** The binding to the native engine is **lazy**: it resolves on **first invocation** inside a running task, after the task service has initialised. Calling the wrapper **before** `createApp` has booted the task service throws `InitializationError`.
- The engine keys checkpoints using the wrapped function's **`Function.name`**. **Anonymous arrow functions all share an empty name and can collide.** **MUST** use **named function expressions** or **named async functions** for anything you wrap with `step`.
- On recovery, completed steps short-circuit to cached results — use for expensive or non-idempotent segments.

**MUST** ensure step bodies are safe to skip on replay when already recorded (idempotent reads, or deduped writes).

**NEVER** call `this.task.start()` from inside a `step` body or another task handler in a way that creates unbounded nested task fan-out. Orchestrate with separate tasks or explicit emits.

**SHOULD** keep `step` units small and name them after their effect. Engine step events use the `custom:step:…` pattern on the WAL; the **`executeTask` bridge drops `custom:step:*` events** (WAL-only checkpoints, not client SSE).

---

## 6. `executeTask`: The Common Pattern

`this.executeTask(res, taskName, input, settings?)` bridges **`this.task.start` → SSE subscribe loop** for the POST-and-stream pattern.

```typescript
injectRoutes(router: IAppRouter) {
  this.route(router, {
    name: "run",
    method: "post",
    path: "/run",
    handler: async (req, res) => {
      await this.executeTask(res, "agent-loop", req.body, {
        cancelOnDisconnect: true,
        disconnectGraceMs: 5000,
        telemetry: { traces: true, metrics: true },
      });
    },
  });
}
```

**`ExecuteTaskSettings`** (only fields that exist):

- `cancelOnDisconnect?` — default `true`; when `true`, after the client closes the TCP connection the bridge waits **`disconnectGraceMs`** (default **5000** ms) then calls `this.task.stop` with reason `client_disconnected`. Set `cancelOnDisconnect: false` for long OBO runs where you expect `EventSource` reconnects. **Note:** OBO tokens still expire (~1 hour); multi-hour OBO work should use `autoRecover: false` and **`resume` from a fresh auth** before token expiry.
- `disconnectGraceMs?` — non-negative milliseconds; ignored when `cancelOnDisconnect` is `false`.
- `telemetry?` — `{ traces?, metrics? }` (defaults `true`).

**Compile-time `never` guards** (do not pass): `retry`, `cache`, `timeout`, `stream`, **`userId`**. the task service replaces retry/cache/timeout; the bridge wire is fixed (no `stream.eventFilter`); identity must never be taken from request bodies.

**Identity / OBO.** The bridge passes `userId` and `context` from **`getCurrentUserContext()`** into `this.task.start`. For OBO, call through the proxy: **`await this.asUser(req).executeTask(res, …)`**. For service principal, call `this.executeTask` without entering user context.

**Wire behaviour (in order):**

1. `this.task.start(taskName, input, { userId, context })`.
2. If headers are not yet sent: set **`X-AppKit-Task-Idempotency-Key`**, call `setupSseHeaders(res)`, write **`event: ready`** with the IK in JSON.
3. `this.task.subscribe(idempotencyKey, lastSeq)` where `lastSeq` comes from **`Last-Event-ID`** on the request.
4. For each stream event: **heartbeats** become SSE **comments** (`: hb`), **`custom:step:*`** are skipped, reserved custom names are dropped with a warning, other **`custom:`** events are stripped to the short name for `event:`, **`id:`** is set to `streamSeq` for replay, payloads are JSON with BigInt-safe stringification.
5. On engine terminal types **`completed`**, **`failed`**, **`cancelled`**, the bridge ends the response after forwarding that frame.
6. On AppKit shutdown, active bridges receive **`event: error`** with **`data: {"message":"server_shutting_down"}`** (best effort) before the iterator closes.

**MUST NOT** pass `retry`, `cache`, `timeout` (interceptor sense), `stream`, or `userId` in settings — they are rejected by types.

**MUST NOT** call `this.executeTask` outside a request handler without an Express `Response` you own. From `setup`, cron, or workers, use **`this.requireTask().start`** / **`subscribe`** directly (and set `SubmitOptions.context` yourself if OBO).

**SHOULD** control what the client sees **only** via `ctx.emit` names and payloads (optionally typed with `TaskDefinition` generics).

---

## 7. OBO (`asUser`) with the task service

**MUST** use `await this.asUser(req).executeTask(...)` when the task body calls plugin code that depends on **`runInUserContext`** (warehouse OBO, etc.). The bridge forwards the live **`UserContext`** as `ctx.context` — it is **never** stored in SQLite; it exists only for the current attempt.

**NEVER** pass a fake `userId` through settings (the field does not exist) or trust client-supplied identity for resume/stop.

**MUST** for OBO tasks that must survive process restart **register with `autoRecover: false`** and design **`this.task.resume(idempotencyKey, { userId, context })`** from a **fresh authenticated request** that re-establishes **`UserContext`**:

```typescript
// setup — OBO-capable task; no automatic recovery without context
this.task.task({
  name: `${this.name}:query`,
  execute: (input, ctx) => this._runQuery(input, ctx),
  autoRecover: false,
});

// Fresh authenticated route: resume must pass the same userId as submit time, and for OBO
// a live context object — mirror Plugin.asUser(req) (ServiceContext + token headers).
// See packages/appkit/src/plugins/analytics/analytics.ts (`_runQueryTask`) for the throw-if-missing contract.
await this.requireTask().resume(ikFromClient, {
  userId: this.resolveUserId(req),
  // OBO: add `context` — the live `UserContext` for this request (what `executeTask` forwards).
});
```

The **analytics plugin** is the reference: `_runQueryTask` uses **`autoRecover: false`** and **throws** if `input.isAsUser` is true but `ctx.context` is missing (resume/recovery without `context: req` would otherwise risk running as the wrong principal).

**MUST** pass **`context`** compatible with your handler when resuming OBO work — typically by routing resume through the same `asUser(req)` machinery so `executeTask` or your resume callsite captures `ServiceContext.createUserContext(...)`.

**SHOULD** scope any **application-level cache** keys with `getCurrentUserId()` for OBO and a stable SP marker for service tasks.

---

## 8. Recovery Patterns (Cookbook)

Use the **`custom:`** prefix when scanning `ctx.previousEvents`.

### 8a. Agentic Loop

Persist conversation state in your DB; use events for streaming only.

```typescript
this.task.task({
  name: "chat",
  execute: async (input, ctx) => {
    if (ctx.isRecovery) {
      await ctx.emit("recovered", { turns: await this.countDbTurns(input.sessionId) });
    }
    // …
  },
  autoRecover: true,
});
```

### 8b. Staged Pipeline

```typescript
async pipeline(input: PipelineInput, ctx: TaskContext) {
  const completed = new Set(
    ctx.previousEvents
      .filter(e => e.eventType === "custom:stage_done")
      .map(e => (e.payload as { stage: string }).stage),
  );
  if (!completed.has("extract")) {
    await this.extract(input);
    await ctx.emit("stage_done", { stage: "extract" });
  }
  // …
}
```

### 8c. Saga (Forward + Compensate)

```typescript
async saga(input: SagaInput, ctx: TaskContext) {
  const completed = ctx.previousEvents
    .filter(e => e.eventType === "custom:step_done")
    .map(e => e.payload as { name: string; context: unknown });
  const failed = ctx.previousEvents.find(e => e.eventType === "custom:step_failed");
  // …
}
```

---

## 9. Errors, Suspension, and Shutdown

**MUST** handle failures from **`this.task.stop`**, **`resume`**, and **`start`** explicitly in production code (`try/catch`, typed error inspection). The vendored `Engine` throws on some invalid transitions; there is no stable public `isTaskPauseError` helper exported from `@databricks/appkit` today — branch on message / name cautiously or map errors in your layer.

**MUST** rely on AppKit graceful shutdown: **`TaskManager.shutdown()`** drains active SSE bridges ( **`server_shutting_down`** ) then shuts down the native engine. Plugins **MUST NOT** call low-level shutdown from random hooks unless you know you are replacing AppKit lifecycle.

**SHOULD** call **`this.streamManager.abortAll()`** in **`shutdown()`** if your plugin uses **`executeStream`** alongside the task service SSE — `executeTask` subscriptions are managed by the the task service bridge registry.

---

## 10. NEVER Rules (Compile-Free Footguns)

**NEVER** call **`this.task.start()`** from inside another task in a way that creates unbounded nested task explosions without a clear orchestration model.

**NEVER** mutate logical **`input`** fields between attempts for recovery incorrectly — the engine replays stored input. If you need derived state, recompute it from `previousEvents` or durable storage.

**NEVER** throw inside **`recover`** expecting a silent full retry — treat throws as failed recovery per engine semantics.

**NEVER** assume **`ctx.context`** is non-null on recovery for **OBO** tasks. Without a fresh **`UserContext`** from **`resume`**, OBO handlers **MUST** fail closed (see analytics plugin). **Recovery that needs OBO `MUST` use `this.task.resume(ik, { userId, context })` from a new authorised HTTP request**, not blind `autoRecover: true`.

**NEVER** use **`simulateCrash`** outside dev/tests. It requires **`engine.enableTestMode: true`** in config and exists to exercise recovery paths.

**NEVER** import the vendored **`Task`** singleton or **`Engine`** directly for plugin business logic. Use **`this.task`** (via **`requireTask()`** when you need a non-null reference) so lifecycle, telemetry, and AppKit guards stay consistent.

**NEVER** emit **reserved** custom event names (section 4) — they are dropped with a warning and never reach the client.

---

## 11. Testing

**MUST** mock the task service in unit tests (for example `vi.mock("@databricks/appkit", …)` swapping the module surface) or inject a fake `TaskManager` if your harness supports it.

**SHOULD** when integration-testing, opt into **`enableTestMode: true`** in the task service config only in tests, then exercise **`this.task.simulateCrash(idempotencyKey)`** and recovery.

**SHOULD** assert:

- Handlers do not double-commit side effects when re-run under the same IK.
- Recovery skips work based on **`custom:*`** events in `previousEvents`.
- OBO resume without **`context`** fails loudly where your plugin requires it.

---

## 12. Quick Reference

```typescript
import {
  step,
  TASK_IDEMPOTENCY_HEADER,
  type TaskContext,
} from "@databricks/appkit";

// setup (inside Plugin subclass)
async setup() {
  this.requireTask().task({
    name: "my-op",
    execute: (input, ctx) => this.myOp(input, ctx),
    autoRecover: true,
  });
}

// Route — service principal
this.route(router, {
  name: "run-sp",
  method: "post",
  path: "/run",
  handler: async (req, res) => {
    await this.executeTask(res, "my-op", req.body, {
      cancelOnDisconnect: true,
      disconnectGraceMs: 5000,
    });
    // res.getHeader(TASK_IDEMPOTENCY_HEADER) when headers are readable (same-origin fetch)
  },
});

// Route — OBO (executeTask under asUser proxy)
this.route(router, {
  name: "run-obo",
  method: "post",
  path: "/run-as-user",
  handler: async (req, res) => {
    await this.asUser(req).executeTask(res, "my-op", req.body, {
      cancelOnDisconnect: false,
    });
  },
});

// Handler with recovery inspection (engine stores custom:* on TaskEvent.eventType)
async myOp(input: MyInput, ctx: TaskContext): Promise<MyOutput> {
  const last = ctx.previousEvents.findLast(e => e.eventType === "custom:stage_done");
  void last;
  await ctx.emit("stage_done", { stage: 1 });
  return { ok: true };
}

// Programmatic consume
const tf = this.requireTask();
const handle = await tf.start("my-op", input, { userId: "optional-owner-id" });
for await (const ev of tf.subscribe(handle.idempotencyKey)) {
  void ev.event.eventType;
}
```

Named step (avoid anonymous `step(async (ctx) => …)` collisions):

```typescript
const fetchRows = step(async function fetchRows(ctx: TaskContext, id: string) {
  return lookup(id);
});
```
