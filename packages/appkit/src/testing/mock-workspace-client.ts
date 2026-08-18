/**
 * A never-crash fake `WorkspaceClient`. Declared paths resolve their value;
 * everything else resolves `undefined` instead of throwing.
 */

import type { Mock } from "vitest";
import { vi } from "vitest";

import type { WorkspaceClient } from "../workspace-client";

type Any = any;

type LegacyClient = ReturnType<WorkspaceClient["toLegacyWorkspaceClient"]>;

/** Options for {@link createMockWorkspaceClient}. */
export interface CreateMockWorkspaceClientOptions {
  /**
   * Responses keyed by dotted path (`"jobs.getRun"`). A function value is called
   * with the arguments, so a test can script behaviour or reject.
   */
  responses?: Record<string, Any>;

  /** Seed `config`; `host` must stay a real string. */
  config?: Partial<WorkspaceClient["config"]>;

  /** Apply the canned defaults (SQL succeeds, warehouse RUNNING). Default true. */
  defaults?: boolean;
}

export type MockWorkspaceClient = WorkspaceClient;

/**
 * Applied beneath caller-supplied `responses`.
 *
 * The first three must stay byte-identical to the old `fixtures.ts` values — 13
 * suites reach them implicitly via `mockServiceContext`. `currentUser.me` is
 * required: `ServiceContext.createContext` reads `.id`, so `createApp({ client })`
 * cannot boot without it.
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

/** The seven generically-proxied services; `config`/`apiClient` are seeded below. */
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
 * Answered with `undefined` rather than a minted mock. `then` is load-bearing:
 * without it a service is thenable, so `await client.jobs` hangs.
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
 * Symbols and denied names short-circuit before minting; anything already on the
 * target (seeded members, `Object.prototype`) wins.
 *
 * `ownKeys`/`getOwnPropertyDescriptor` stay at their defaults on purpose —
 * reporting keys makes `util.inspect` probe each one, minting a mock per probe.
 */
function neverCrashGet(namespace: string, mint: (path: string) => Mock) {
  return (target: Any, prop: Any): Any => {
    if (typeof prop === "symbol") return Reflect.get(target, prop);
    if (PASSTHROUGH_DENY.has(prop)) return undefined;
    if (prop in target) return target[prop];
    return mint(`${namespace}.${String(prop)}`);
  };
}

// In a WeakMap, not on the client: a stray own property would show up in
// util.inspect, toEqual, and key enumeration.
const clientFns = new WeakMap<WorkspaceClient, Map<string, Mock>>();

/**
 * @example
 * ```ts
 * const client = createMockWorkspaceClient({
 *   responses: { "jobs.getRun": { state: "TERMINATED" } },
 * });
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

  // Shared with the legacy view and getMockFn, so both see the same functions.
  const fns = new Map<string, Mock>();

  /** Mint once per path, so call assertions see a stable reference. */
  function mint(path: string): Mock {
    const cached = fns.get(path);
    if (cached) return cached;

    const response = merged[path];
    const fn = vi.fn();
    if (typeof response === "function") fn.mockImplementation(response);
    else fn.mockResolvedValue(response);

    fns.set(path, fn);
    return fn;
  }

  /** Memoized, so `client.jobs === client.jobs`. */
  const services = new Map<string, Any>();
  function service(namespace: string): Any {
    const cached = services.get(namespace);
    if (cached) return cached;
    const proxy = new Proxy({}, { get: neverCrashGet(namespace, mint) });
    services.set(namespace, proxy);
    return proxy;
  }

  /** Pull `"config.*"` / `"apiClient.*"` entries out so they seed real values. */
  function seededOverrides(namespace: string): Record<string, Any> {
    const prefix = `${namespace}.`;
    const out: Record<string, Any> = {};
    for (const [key, value] of Object.entries(merged)) {
      if (key.startsWith(prefix)) out[key.slice(prefix.length)] = value;
    }
    return out;
  }

  // `host` is read as a string and throws if falsy, so it cannot be a mock.
  const configTarget: Record<string, Any> = {
    host: "https://test.databricks.com",
    authenticate: vi.fn((headers?: Headers) => {
      headers?.set?.("Authorization", "Bearer test-token");
    }),
    ensureResolved: vi.fn().mockResolvedValue(undefined),
    ...config,
    ...seededOverrides("config"),
  };

  // userAgent() must be synchronous (a Promise stringifies to "[object Promise]"
  // inside a Headers value); request resolves {} so destructuring works.
  const apiClientTarget: Record<string, Any> = {
    userAgent: vi.fn().mockReturnValue("appkit-test/1.0"),
    request: vi.fn().mockResolvedValue({}),
  };
  for (const [key, value] of Object.entries(seededOverrides("apiClient"))) {
    const fn = typeof value === "function" ? vi.fn(value) : vi.fn();
    if (typeof value !== "function") fn.mockResolvedValue(value);
    apiClientTarget[key] = fn;
    fns.set(`apiClient.${key}`, fn);
  }
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

  /** Memoized; routes facade names onto the same objects, others onto the floor. */
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
 * The typed assertion path onto a mocked method — facade accessors are SDK-typed,
 * so `expect(client.jobs.getRun).toHaveBeenCalled()` does not typecheck.
 *
 * Minting is idempotent, so this can be called before the code under test runs.
 * Throws for a non-function member such as `"config.host"`.
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
