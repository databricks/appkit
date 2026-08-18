/**
 * A never-crash fake `WorkspaceClient`: declare only the responses your plugin
 * actually reads, and every other path resolves `undefined` instead of throwing.
 *
 * The 9-member facade is typed, so `client.jbos` is a compile error, while each
 * service *inside* it is a `Proxy` that mints a memoized `vi.fn()` per method —
 * that is where the legacy SDK's surface is too large to hand-write. Two members
 * are deliberately not mocks: `config.host` is a real string (the files-upload
 * path builds URLs from it) and `apiClient.userAgent()` is synchronous (its
 * result goes straight into a `Headers` value).
 *
 * @module
 */

import type { Mock } from "vitest";
import { vi } from "vitest";

import type { WorkspaceClient } from "../workspace-client";

// Test fixtures intentionally use loose shapes; `no-explicit-any` is disabled
// repo-wide (see .oxlintrc.json), so a local alias keeps the intent readable.
type Any = any;

/** The legacy client `toLegacyWorkspaceClient()` hands back. */
type LegacyClient = ReturnType<WorkspaceClient["toLegacyWorkspaceClient"]>;

/** Options for {@link createMockWorkspaceClient}. */
export interface CreateMockWorkspaceClientOptions {
  /**
   * Responses keyed by dotted path — `"jobs.getRun"`, `"apiClient.request"`,
   * `"config.host"`. A **function** value is invoked with the call arguments, so
   * a test can script per-argument behaviour or throw/reject to propagate an
   * error; any other value is resolved as-is. An unlisted path resolves
   * `undefined`.
   */
  responses?: Record<string, Any>;

  /**
   * Seed the `config` object — most usefully `host`, which must stay a real
   * string. Unlisted members still reach the never-crash floor.
   */
  config?: Partial<WorkspaceClient["config"]>;

  /**
   * Whether to apply the built-in canned defaults (SQL succeeds, warehouse
   * `RUNNING`, a current user with an `id`). Pass `false` to leave every path
   * unresolved so a test can script it. Defaults to `true`.
   */
  defaults?: boolean;
}

/**
 * What {@link createMockWorkspaceClient} returns. Structurally the real
 * facade — the fake is a drop-in for anything typed against `WorkspaceClient`.
 */
export type MockWorkspaceClient = WorkspaceClient;

/**
 * Canned defaults, applied *beneath* any caller-supplied `responses` entry for
 * the same path.
 *
 * The first three are byte-identical to the historical `createMockWorkspaceClient`
 * in `fixtures.ts`, because 13 test files reach them implicitly through
 * `mockServiceContext` and must see no behavioural change.
 *
 * `currentUser.me` is additive and load-bearing: `ServiceContext.createContext`
 * reads `currentUser.id` off the result, so an unresolved `me()` is a TypeError
 * rather than a clean error, and `createApp({ client })` cannot boot without it.
 */
const DEFAULT_RESPONSES: Record<string, Any> = {
  "statementExecution.executeStatement": {
    status: { state: "SUCCEEDED" },
    result: { data: [] },
  },
  "warehouses.get": { state: "RUNNING" },
  "warehouses.start": undefined,
  "currentUser.me": {
    id: "test-service-user",
    userName: "test-service-user",
  },
};

/**
 * The seven services that get a generic never-crash Proxy. `config` and
 * `apiClient` are the other two facade members and are handled separately as
 * seeded objects, because some of their members must not be mocks.
 */
const FACADE_SERVICES = [
  "files",
  "warehouses",
  "genie",
  "jobs",
  "statementExecution",
  "servingEndpoints",
  "currentUser",
] as const;

/**
 * Property names the `get` trap must answer with `undefined` instead of minting
 * a mock.
 *
 * `then` is the critical one: without it a service looks like a thenable, so
 * `await client.jobs` (or any `Promise.resolve(service)`) either hangs forever
 * or resolves to whatever the minted `then` mock returned. The rest keep
 * Vitest's matchers, `JSON.stringify`, and React-style probes from being
 * answered with a mock that lies about the object's nature.
 *
 * Module-level so it is allocated once, not on every property access.
 */
const PASSTHROUGH_DENY: ReadonlySet<string> = new Set([
  "then",
  "catch",
  "finally",
  "toJSON",
  "inspect",
  "constructor",
  "$$typeof",
  "asymmetricMatch",
]);

/**
 * Builds the shared `get` trap.
 *
 * Three short-circuits run before anything is minted:
 * 1. **Symbol keys** delegate to `Reflect.get`. Minting on `Symbol.toPrimitive`,
 *    `Symbol.iterator`, `Symbol.asyncIterator`, `nodejs.util.inspect.custom`, or
 *    Vitest's `asymmetricMatch` probe breaks `util.inspect`, `%O` logging,
 *    `toEqual`, and `for await`.
 * 2. **{@link PASSTHROUGH_DENY}** returns `undefined`.
 * 3. **Anything already reachable on the target** wins — that covers the seeded
 *    members of `config`/`apiClient` and lets `Object.prototype` methods such as
 *    `toString` through, so `String(service)` yields `"[object Object]"` rather
 *    than stringifying a Promise.
 *
 * `ownKeys`/`getOwnPropertyDescriptor` are deliberately left at their defaults,
 * so structural equality and `util.inspect` see `{}` instead of recursing
 * forever probing properties that mint more mocks.
 */
function neverCrashGet(namespace: string, mint: (path: string) => Mock) {
  return (target: Any, prop: Any): Any => {
    if (typeof prop === "symbol") return Reflect.get(target, prop);
    if (PASSTHROUGH_DENY.has(prop)) return undefined;
    if (prop in target) return target[prop];
    return mint(`${namespace}.${String(prop)}`);
  };
}

/**
 * Path map per client, kept in a `WeakMap` rather than on the client itself so
 * the fake stays structurally identical to the real facade — a stray own
 * property would show up in `util.inspect`, `toEqual`, and key enumeration.
 */
const clientFns = new WeakMap<WorkspaceClient, Map<string, Mock>>();

/**
 * Creates a fake `WorkspaceClient` that survives any facade access.
 *
 * @param options - See {@link CreateMockWorkspaceClientOptions}.
 * @returns A fake typed as the real `WorkspaceClient`.
 *
 * @example
 * ```ts
 * const client = createMockWorkspaceClient({
 *   responses: {
 *     "jobs.getRun": { state: "TERMINATED", result_state: "SUCCESS" },
 *     "apiClient.request": { results: [] },
 *   },
 * });
 *
 * const run = await client.jobs.getRun({ run_id: 123 });
 * expect(getMockFn(client, "jobs.getRun")).toHaveBeenCalledWith({ run_id: 123 });
 * ```
 */
export function createMockWorkspaceClient(
  options: CreateMockWorkspaceClientOptions = {},
): MockWorkspaceClient {
  const { responses = {}, config = {}, defaults = true } = options;

  // Caller entries win over the canned defaults for the same path.
  const merged: Record<string, Any> = defaults
    ? { ...DEFAULT_RESPONSES, ...responses }
    : { ...responses };

  /**
   * Every minted mock, keyed by dotted path. Shared by the facade view, the
   * legacy view, and {@link getMockFn}, so `legacy.jobs.getRun` and
   * `client.jobs.getRun` are the same function object and one `responses` entry
   * covers both.
   */
  const fns = new Map<string, Mock>();

  /** Mint-once-per-path, so call assertions see a stable reference. */
  function mint(path: string): Mock {
    const cached = fns.get(path);
    if (cached) return cached;

    const response = merged[path];
    const fn = vi.fn();
    // A function response is the scripting hook: it receives the call
    // arguments, and a throw/rejection propagates to the caller.
    if (typeof response === "function") fn.mockImplementation(response);
    else fn.mockResolvedValue(response);

    fns.set(path, fn);
    return fn;
  }

  /** Memoized service proxies, so `client.jobs === client.jobs`. */
  const services = new Map<string, Any>();
  function service(namespace: string): Any {
    const cached = services.get(namespace);
    if (cached) return cached;
    const proxy = new Proxy({}, { get: neverCrashGet(namespace, mint) });
    services.set(namespace, proxy);
    return proxy;
  }

  /**
   * Splits `responses` entries addressed at a seeded namespace out of the
   * dotted-path map, so `"config.host"` seeds a real string rather than minting
   * a mock that would make `new URL(...)` produce garbage.
   */
  function seededOverrides(namespace: string): Record<string, Any> {
    const prefix = `${namespace}.`;
    const out: Record<string, Any> = {};
    for (const [key, value] of Object.entries(merged)) {
      if (key.startsWith(prefix)) out[key.slice(prefix.length)] = value;
    }
    return out;
  }

  /**
   * `config` is the one place a bare Proxy is actively wrong: `host` is read as
   * a string and throws if falsy, and `authenticate`/`ensureResolved` are
   * methods on that same object.
   */
  const configTarget: Record<string, Any> = {
    host: "https://test.databricks.com",
    authenticate: vi.fn((headers?: Headers) => {
      headers?.set?.("Authorization", "Bearer test-token");
    }),
    ensureResolved: vi.fn().mockResolvedValue(undefined),
    ...config,
    ...seededOverrides("config"),
  };

  /**
   * `apiClient` is seeded for two reasons: `userAgent()` must be **synchronous**
   * (a Promise stringifies to `[object Promise]` inside a `Headers` value), and
   * `request` resolves `{}` rather than `undefined` so
   * `const { contents } = await request(...)` destructures instead of throwing.
   */
  const apiClientTarget: Record<string, Any> = {
    userAgent: vi.fn().mockReturnValue("appkit-test/1.0"),
    request: vi.fn().mockResolvedValue({}),
  };
  // Declared responses are wrapped so they stay assertable as mocks; a raw
  // value would lose the call record that `expect(...).toHaveBeenCalled()` needs.
  for (const [key, value] of Object.entries(seededOverrides("apiClient"))) {
    const fn = typeof value === "function" ? vi.fn(value) : vi.fn();
    if (typeof value !== "function") fn.mockResolvedValue(value);
    apiClientTarget[key] = fn;
    fns.set(`apiClient.${key}`, fn);
  }
  // Seeded mocks join the path map too, so getMockFn resolves them uniformly.
  for (const key of ["userAgent", "request"]) {
    if (!fns.has(`apiClient.${key}`)) {
      fns.set(`apiClient.${key}`, apiClientTarget[key] as Mock);
    }
  }
  for (const [key, value] of Object.entries(configTarget)) {
    if (typeof value === "function" && !fns.has(`config.${key}`)) {
      fns.set(`config.${key}`, value as Mock);
    }
  }

  const configProxy = new Proxy(configTarget, {
    get: neverCrashGet("config", mint),
  });
  const apiClientProxy = new Proxy(apiClientTarget, {
    get: neverCrashGet("apiClient", mint),
  });

  /**
   * The legacy view, memoized. Routes the 9 facade names back onto the same
   * objects the facade exposes, and gives every un-faceted legacy service
   * (`legacy.clusters.list()`) the same never-crash floor.
   */
  let legacy: LegacyClient | undefined;
  function toLegacyWorkspaceClient(): LegacyClient {
    legacy ??= new Proxy(
      {},
      {
        get: (target: Any, prop: Any): Any => {
          if (typeof prop === "symbol") return Reflect.get(target, prop);
          if (PASSTHROUGH_DENY.has(prop)) return undefined;
          if (prop === "config") return configProxy;
          if (prop === "apiClient") return apiClientProxy;
          if (prop === "toLegacyWorkspaceClient") {
            return toLegacyWorkspaceClient;
          }
          return service(String(prop));
        },
      },
    ) as LegacyClient;
    return legacy;
  }

  const client: WorkspaceClient = {
    ...(Object.fromEntries(
      FACADE_SERVICES.map((name) => [name, service(name)]),
    ) as Pick<WorkspaceClient, (typeof FACADE_SERVICES)[number]>),
    config: configProxy as WorkspaceClient["config"],
    apiClient: apiClientProxy as WorkspaceClient["apiClient"],
    toLegacyWorkspaceClient,
  };

  clientFns.set(client, fns);
  return client;
}

/**
 * The typed assertion path onto a mocked method.
 *
 * Facade accessors are typed against the legacy SDK, so
 * `expect(client.jobs.getRun).toHaveBeenCalled()` does not typecheck — the real
 * signature is not a `Mock`. This resolves the same memoized function by dotted
 * path and hands it back correctly typed. It replaces the `mocks` handle that
 * `createConfigurableMockWorkspaceClient` used to return.
 *
 * Minting is idempotent, so calling this *before* the code under test runs is
 * fine — it returns the very function that code will call, with zero recorded
 * calls.
 *
 * @param client - A client from {@link createMockWorkspaceClient}.
 * @param path - Dotted path, e.g. `"jobs.getRun"` or `"apiClient.request"`.
 * @returns The memoized mock for that path.
 * @throws If `client` is not a mock client, or the path names a non-function
 *   member such as `"config.host"`.
 *
 * @example
 * ```ts
 * const client = createMockWorkspaceClient();
 * const getRun = getMockFn(client, "jobs.getRun");
 * await client.jobs.getRun({ run_id: 1 });
 * expect(getRun).toHaveBeenCalledWith({ run_id: 1 });
 * ```
 */
export function getMockFn(client: MockWorkspaceClient, path: string): Mock {
  const fns = clientFns.get(client);
  if (!fns) {
    throw new Error(
      "getMockFn: not a createMockWorkspaceClient() client. Pass the client " +
        "the builder returned, not a hand-rolled object.",
    );
  }

  const cached = fns.get(path);
  if (cached) return cached;

  // Resolve through the client so the path mints exactly what the code under
  // test would reach, seeded members included.
  const dot = path.indexOf(".");
  const namespace = dot === -1 ? path : path.slice(0, dot);
  const member = dot === -1 ? "" : path.slice(dot + 1);
  const resolved = member
    ? (client as Any)[namespace]?.[member]
    : (client as Any)[namespace];

  if (typeof resolved !== "function") {
    throw new Error(
      `getMockFn: "${path}" is not a mocked function (got ${typeof resolved}). ` +
        "Members seeded with a real value, such as config.host, have no mock.",
    );
  }
  return resolved as Mock;
}
