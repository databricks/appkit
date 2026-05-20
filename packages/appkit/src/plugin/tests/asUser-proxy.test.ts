/**
 * Tests for `Plugin.asUser(req)` — the proxy that wraps method calls and
 * `exports()` results in the user's AsyncLocalStorage scope.
 *
 * `plugin.test.ts` already covers the dev-fallback proxy at the method-call
 * level. This file exists to cover:
 *   1. Real OBO method calls (token + userId headers)
 *   2. `exports()` interception in both OBO and dev-fallback modes
 *   3. Edge cases: nested objects, class instances, callable exports,
 *      excluded lifecycle methods, async propagation, error cleanup
 *
 * These tests probe the proxy directly, not through the AppKit layer.
 * The AppKit-integration tests live in `core/tests/appkit-as-user-exports.test.ts`.
 */

import {
  type ContextManager,
  context as otelContext,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { createMockTelemetry, mockServiceContext } from "@tools/test-helpers";
import type express from "express";
import type { BasePluginConfig } from "shared";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { AppManager } from "../../app";
import { CacheManager } from "../../cache";
import { getUserContext } from "../../context/execution-context";
import { ServiceContext } from "../../context/service-context";
import { StreamManager } from "../../stream";
import type { ITelemetry, TelemetryProvider } from "../../telemetry";
import { TelemetryManager } from "../../telemetry";
import { isDevOboFallback, Plugin } from "../plugin";

vi.mock("@databricks/sdk-experimental", () => ({
  ApiError: class extends Error {
    statusCode = 500;
  },
}));

vi.mock("../../app");
vi.mock("../../cache", () => ({
  CacheManager: { getInstanceSync: vi.fn() },
}));
vi.mock("../../stream");
vi.mock("../../telemetry", () => ({
  TelemetryManager: { getProvider: vi.fn() },
  normalizeTelemetryOptions: vi.fn(() => ({ traces: false })),
}));

// ── Test plugins ────────────────────────────────────────────────────

/**
 * Captures `getUserContext()` at call time and exposes it for assertions.
 * Covers every shape a plugin can export: class method, arrow function,
 * nested object, class instance, primitives, and callable-style exports.
 */
class ProbePlugin extends Plugin<BasePluginConfig> {
  /** Captures the user-id observed on the last call, for nested-call tests. */
  observedFromInner: string | undefined;

  async observeAsync(): Promise<string | undefined> {
    return getUserContext()?.userId;
  }

  observeSync(): string | undefined {
    return getUserContext()?.userId;
  }

  // Calls observeSync via `this` — we use this to prove the inner call
  // inherits the user context from the outer wrapped call.
  outerCallsInner(): string | undefined {
    this.observedFromInner = this.observeSync();
    return this.observedFromInner;
  }

  syncThrows(): never {
    throw new Error("sync boom");
  }

  async asyncRejects(): Promise<never> {
    throw new Error("async boom");
  }

  exports() {
    return {
      classMethod: this.observeSync.bind(this),
      arrowFn: () => getUserContext()?.userId,
      asyncArrowFn: async () => {
        // Force an await so we exercise AsyncLocalStorage propagation.
        await Promise.resolve();
        return getUserContext()?.userId;
      },
      nested: {
        innerArrow: () => getUserContext()?.userId,
        deeper: {
          deepest: () => getUserContext()?.userId,
        },
      },
      // Class instance — must NOT be recursed into by wrapExportFunctions.
      classInstance: new Date("2026-01-01"),
      // Array — must NOT be recursed into either.
      arrayValue: [() => getUserContext()?.userId],
      // Primitives — must be preserved exactly.
      count: 42,
      name: "probe",
      nullish: null,
    };
  }
}

/** Exports as a function (the files/jobs pattern) — never wrapped. */
class CallablePlugin extends Plugin<BasePluginConfig> {
  exports() {
    return (key: string) => `handle:${key}`;
  }
}

/** Exports returns `undefined` — must be treated as `{}`. */
class NullExportsPlugin extends Plugin<BasePluginConfig> {
  exports(): undefined {
    return undefined;
  }
}

// ── Test plumbing ───────────────────────────────────────────────────

function createReqWithObo(): express.Request {
  return {
    header: (name: string) => {
      const map: Record<string, string> = {
        "x-forwarded-access-token": "user-token-abc",
        "x-forwarded-user": "alice",
        "x-forwarded-email": "alice@example.com",
      };
      return map[name.toLowerCase()];
    },
  } as unknown as express.Request;
}

function createReqWithoutToken(): express.Request {
  return {
    header: () => undefined,
  } as unknown as express.Request;
}

describe("Plugin.asUser proxy", () => {
  let mockTelemetry: ITelemetry;
  let mockCache: CacheManager;
  let serviceContextMock: Awaited<ReturnType<typeof mockServiceContext>>;
  let config: BasePluginConfig;
  let contextManager: ContextManager;

  beforeAll(() => {
    otelContext.disable();
    contextManager = new AsyncLocalStorageContextManager().enable();
    otelContext.setGlobalContextManager(contextManager);
  });

  afterAll(() => {
    otelContext.disable();
  });

  beforeEach(async () => {
    ServiceContext.reset();
    serviceContextMock = await mockServiceContext();

    mockTelemetry = createMockTelemetry();
    mockCache = {
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
    } as unknown as CacheManager;

    vi.mocked(CacheManager.getInstanceSync).mockReturnValue(mockCache);
    vi.mocked(AppManager).mockImplementation(
      () => ({ getAppQuery: vi.fn() }) as unknown as AppManager,
    );
    vi.mocked(StreamManager).mockImplementation(
      () =>
        ({ stream: vi.fn(), abortAll: vi.fn() }) as unknown as StreamManager,
    );
    vi.mocked(TelemetryManager.getProvider).mockReturnValue(
      mockTelemetry as TelemetryProvider,
    );

    config = { name: "probe" };
  });

  afterEach(() => {
    serviceContextMock?.restore();
    vi.clearAllMocks();
  });

  // ── Real OBO: method-call proxy ────────────────────────────────────

  describe("real OBO — method calls", () => {
    test("async method runs inside the user's AsyncLocalStorage scope", async () => {
      const plugin = new ProbePlugin(config);
      const proxied = plugin.asUser(createReqWithObo());

      await expect(proxied.observeAsync()).resolves.toBe("alice");
    });

    test("sync method runs inside the user's AsyncLocalStorage scope", () => {
      const plugin = new ProbePlugin(config);
      const proxied = plugin.asUser(createReqWithObo());

      expect(proxied.observeSync()).toBe("alice");
    });

    test("getUserContext() returns undefined outside the proxy", () => {
      const plugin = new ProbePlugin(config);
      // Sanity: SP-side calls have no user context.
      expect(plugin.observeSync()).toBeUndefined();
    });

    test("non-function properties pass through unchanged", () => {
      const plugin = new ProbePlugin(config);
      const proxied = plugin.asUser(createReqWithObo());

      expect(proxied.name).toBe(plugin.name);
    });

    test("excluded lifecycle methods (setup) are not wrapped in user context", async () => {
      class WatchSetup extends ProbePlugin {
        observedDuringSetup: string | undefined;
        async setup() {
          this.observedDuringSetup = getUserContext()?.userId;
        }
      }

      const plugin = new WatchSetup(config);
      const proxied = plugin.asUser(createReqWithObo());

      await proxied.setup();

      // setup is in EXCLUDED_FROM_PROXY, so it runs as the SP.
      expect(plugin.observedDuringSetup).toBeUndefined();
    });

    test("inner this.method() call inherits the outer user context", () => {
      const plugin = new ProbePlugin(config);
      const proxied = plugin.asUser(createReqWithObo());

      expect(proxied.outerCallsInner()).toBe("alice");
    });

    test("sync throw propagates and clears context after the call", () => {
      const plugin = new ProbePlugin(config);
      const proxied = plugin.asUser(createReqWithObo());

      expect(() => proxied.syncThrows()).toThrow("sync boom");
      // After the call returns, we should be back to no user context.
      expect(getUserContext()).toBeUndefined();
    });

    test("async reject propagates and clears context after the call", async () => {
      const plugin = new ProbePlugin(config);
      const proxied = plugin.asUser(createReqWithObo());

      await expect(proxied.asyncRejects()).rejects.toThrow("async boom");
      expect(getUserContext()).toBeUndefined();
    });
  });

  // ── Real OBO: exports() interception ───────────────────────────────

  describe("real OBO — exports() interception", () => {
    test("class method export sees user context", () => {
      const plugin = new ProbePlugin(config);
      const exports = plugin.asUser(createReqWithObo()).exports();

      expect((exports as any).classMethod()).toBe("alice");
    });

    test("inline arrow function export sees user context", () => {
      const plugin = new ProbePlugin(config);
      const exports = plugin.asUser(createReqWithObo()).exports();

      expect((exports as any).arrowFn()).toBe("alice");
    });

    test("async exported function preserves context across await", async () => {
      const plugin = new ProbePlugin(config);
      const exports = plugin.asUser(createReqWithObo()).exports();

      await expect((exports as any).asyncArrowFn()).resolves.toBe("alice");
    });

    test("nested plain objects are recursed into", () => {
      const plugin = new ProbePlugin(config);
      const exports = plugin.asUser(createReqWithObo()).exports() as any;

      expect(exports.nested.innerArrow()).toBe("alice");
      expect(exports.nested.deeper.deepest()).toBe("alice");
    });

    test("class instance values are not recursed into", () => {
      const plugin = new ProbePlugin(config);
      const exports = plugin.asUser(createReqWithObo()).exports() as any;

      // Date is a class instance; isPlainObject() rejects it, so it's
      // returned identity-equal to the original.
      expect(exports.classInstance).toBeInstanceOf(Date);
      expect(exports.classInstance.toISOString()).toBe(
        "2026-01-01T00:00:00.000Z",
      );
    });

    test("array values are not recursed into", () => {
      const plugin = new ProbePlugin(config);
      const exports = plugin.asUser(createReqWithObo()).exports() as any;

      // The array's contained function is *not* wrapped — arrays aren't
      // plain objects. Calling it directly returns undefined.
      expect(Array.isArray(exports.arrayValue)).toBe(true);
      expect(exports.arrayValue[0]()).toBeUndefined();
    });

    test("non-function primitives are preserved", () => {
      const plugin = new ProbePlugin(config);
      const exports = plugin.asUser(createReqWithObo()).exports() as any;

      expect(exports.count).toBe(42);
      expect(exports.name).toBe("probe");
      expect(exports.nullish).toBeNull();
    });

    test("calling exports() twice returns independent objects", () => {
      const plugin = new ProbePlugin(config);
      const proxied = plugin.asUser(createReqWithObo());

      const first = proxied.exports() as any;
      const second = proxied.exports() as any;

      expect(first).not.toBe(second);
      // Both work independently.
      expect(first.arrowFn()).toBe("alice");
      expect(second.arrowFn()).toBe("alice");
    });

    test("interception does not mutate the underlying export object", () => {
      // Plugin that returns the same exports object reference each call
      // (memoized — an anti-pattern, but the proxy must not corrupt it).
      class MemoizedExportsPlugin extends Plugin<BasePluginConfig> {
        readUser = () => getUserContext()?.userId;
        private cached?: Record<string, unknown>;
        exports() {
          if (!this.cached) {
            this.cached = {
              read: this.readUser,
              nested: { read: this.readUser },
            };
          }
          return this.cached;
        }
      }
      const plugin = new MemoizedExportsPlugin(config);

      const wrapped = plugin.asUser(createReqWithObo()).exports() as any;
      expect(wrapped.read()).toBe("alice");

      // The plugin's own (memoized) exports() must still be the originals.
      const raw = plugin.exports() as any;
      expect(raw.read).toBe(plugin.readUser);
      expect(raw.read()).toBeUndefined();
      expect(raw.nested.read).toBe(plugin.readUser);

      // The wrapped view is a fresh structure, not the same nested object.
      expect(wrapped).not.toBe(raw);
      expect(wrapped.nested).not.toBe(raw.nested);
    });

    test("callable exports (function return) are returned as-is", () => {
      const plugin = new CallablePlugin(config);
      const result = plugin.asUser(createReqWithObo()).exports();

      // Same function identity as the plugin's own exports() return value.
      expect(typeof result).toBe("function");
      expect((result as (k: string) => string)("vol")).toBe("handle:vol");
    });

    test("top-level non-plain object exports pass through as-is", () => {
      // exports() returning an Array, Map, etc. (not plain object, not
      // function) hits the fallthrough branch and is returned unchanged.
      class ArrayExportsPlugin extends Plugin<BasePluginConfig> {
        readonly source: unknown[] = [() => getUserContext()?.userId];
        exports(): unknown[] {
          return this.source;
        }
      }
      const plugin = new ArrayExportsPlugin(config);
      const result = plugin.asUser(createReqWithObo()).exports();

      // Same identity as the plugin's own return — not copied, not wrapped.
      expect(result).toBe(plugin.source);
    });

    test("exports() returning undefined yields an empty object", () => {
      const plugin = new NullExportsPlugin(config);
      const result = plugin.asUser(createReqWithObo()).exports();

      expect(result).toEqual({});
    });

    test("default exports() (empty object) yields an empty object", () => {
      class Bare extends Plugin<BasePluginConfig> {}
      const plugin = new Bare(config);
      const result = plugin.asUser(createReqWithObo()).exports();

      expect(result).toEqual({});
    });
  });

  // ── Real OBO: AsyncLocalStorage propagation ────────────────────────

  describe("real OBO — async propagation", () => {
    test("user context survives Promise.all branches", async () => {
      class Parallel extends Plugin<BasePluginConfig> {
        async fanOut(): Promise<(string | undefined)[]> {
          // Each branch awaits before reading the context, forcing
          // AsyncLocalStorage to bridge multiple microtask hops.
          return Promise.all([
            Promise.resolve().then(() => getUserContext()?.userId),
            Promise.resolve().then(async () => {
              await Promise.resolve();
              return getUserContext()?.userId;
            }),
            Promise.resolve().then(() => getUserContext()?.userId),
          ]);
        }
      }
      const plugin = new Parallel(config);
      const proxied = plugin.asUser(createReqWithObo());

      await expect(proxied.fanOut()).resolves.toEqual([
        "alice",
        "alice",
        "alice",
      ]);
    });

    test("two concurrent proxies do not see each other's user context", async () => {
      const reqAlice = createReqWithObo();
      const reqBob: express.Request = {
        header: (name: string) =>
          ({
            "x-forwarded-access-token": "user-token-bob",
            "x-forwarded-user": "bob",
            "x-forwarded-email": "bob@example.com",
          })[name.toLowerCase()],
      } as unknown as express.Request;

      const plugin = new ProbePlugin(config);

      const [alice, bob] = await Promise.all([
        plugin.asUser(reqAlice).observeAsync(),
        plugin.asUser(reqBob).observeAsync(),
      ]);

      expect(alice).toBe("alice");
      expect(bob).toBe("bob");
    });
  });

  // ── Boundaries: function references that escape the proxy ─────────

  describe("real OBO — function references that escape the proxy", () => {
    test("a function returned by a method is not auto-wrapped", () => {
      class Factory extends Plugin<BasePluginConfig> {
        // The returned arrow is *created* inside the user context, but
        // it's the act of *invoking* it that needs to be in scope.
        // Returning a function out of the proxy hands it back to a caller
        // who is outside any user-context scope, so calling it later sees
        // no context. This documents the proxy's wrapping boundary.
        makeReader(): () => string | undefined {
          return () => getUserContext()?.userId;
        }
      }

      const plugin = new Factory(config);
      const proxied = plugin.asUser(createReqWithObo());

      const reader = proxied.makeReader();
      expect(reader()).toBeUndefined();
    });

    test("a method that returns `this` returns the unwrapped target", () => {
      class Fluent extends Plugin<BasePluginConfig> {
        chain(): this {
          return this;
        }
      }

      const plugin = new Fluent(config);
      const proxied = plugin.asUser(createReqWithObo());

      const result = proxied.chain();

      // The wrapper binds to target before calling, so `this` inside
      // chain() is the raw plugin. Fluent APIs that `return this` break
      // out of the proxy — subsequent calls on the result are SP-scoped.
      expect(result).toBe(plugin);
      expect(result).not.toBe(proxied);
    });

    test("an error thrown by exports() propagates from proxied.exports()", () => {
      class BadExports extends Plugin<BasePluginConfig> {
        exports() {
          throw new Error("exports failed");
        }
      }

      const plugin = new BadExports(config);
      const proxied = plugin.asUser(createReqWithObo());

      expect(() => proxied.exports()).toThrow("exports failed");
      // Nothing should have leaked into the surrounding scope.
      expect(getUserContext()).toBeUndefined();
    });
  });

  // ── Dev fallback exports() interception ────────────────────────────

  describe("dev fallback — exports() interception", () => {
    let originalNodeEnv: string | undefined;

    beforeEach(() => {
      originalNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "development";
    });

    afterEach(() => {
      process.env.NODE_ENV = originalNodeEnv;
    });

    test("exported arrow function runs with isDevOboFallback() === true", () => {
      class DevProbe extends Plugin<BasePluginConfig> {
        captured: boolean | undefined;
        exports() {
          return {
            tag: () => {
              this.captured = isDevOboFallback();
            },
          };
        }
      }

      const plugin = new DevProbe(config);
      const exports = plugin.asUser(createReqWithoutToken()).exports() as {
        tag: () => void;
      };

      exports.tag();

      expect(plugin.captured).toBe(true);
      // The flag should not leak outside the call.
      expect(isDevOboFallback()).toBe(false);
    });

    test("exports() preserves non-function values in dev fallback", () => {
      class DevProbe extends Plugin<BasePluginConfig> {
        exports() {
          return { meta: { version: 1 }, label: "hello" };
        }
      }

      const plugin = new DevProbe(config);
      const exports = plugin.asUser(createReqWithoutToken()).exports() as {
        meta: { version: number };
        label: string;
      };

      expect(exports.meta).toEqual({ version: 1 });
      expect(exports.label).toBe("hello");
    });
  });
});
