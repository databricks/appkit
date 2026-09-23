import { context as otelContext } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import type { AgentAdapter, AgentToolDefinition, ToolProvider } from "shared";
import { describe, expect, expectTypeOf, test, vi } from "vitest";

import { CacheManager } from "../../cache";
import {
  getCallerContext,
  getCurrentPrincipalKey,
  ServiceContext,
} from "../../context";
import { isDevOboFallback } from "../../context/request-scope";
import { Plugin, toPlugin } from "../../plugin";
import { agents } from "../../plugins/agents";
import { createMockRequest, createTestApp } from "../../testing";

class IdentityPlugin extends Plugin implements ToolProvider {
  static manifest = {
    name: "identity" as const,
    displayName: "Identity probe",
    description: "Captures the principal in tests",
    resources: { required: [], optional: [] },
  };
  private marker = "bound";
  identify() {
    return `${this.marker}:${getCurrentPrincipalKey()}`;
  }
  getAgentTools(): AgentToolDefinition[] {
    return [
      {
        name: "read",
        description: "Read identity",
        parameters: { type: "object", properties: {} },
      },
    ];
  }
  async executeAgentTool() {
    await Promise.resolve();
    return getCurrentPrincipalKey();
  }
  exports() {
    return {
      read: this.identify,
      nested: { read: () => getCurrentPrincipalKey() },
      stream: async function* () {
        await Promise.resolve();
        yield getCurrentPrincipalKey();
        await Promise.resolve();
        yield getCurrentPrincipalKey();
      },
      fail: () => {
        throw new Error("scope failure");
      },
      asOther: () => "must not be reachable",
    };
  }
}
class CallablePlugin extends Plugin {
  static manifest = { ...IdentityPlugin.manifest, name: "callable" as const };
  exports() {
    return (_key: string) => ({ read: () => getCurrentPrincipalKey() });
  }
}
const identity = toPlugin(IdentityPlugin);
const callable = toPlugin(CallablePlugin);
const request = (userId: string) =>
  createMockRequest({ obo: { userId, token: `${userId}-token` } });

describe("app-level caller scope", () => {
  test("keeps the plugin alias with one deprecation warning", async () => {
    await using app = await createTestApp({
      plugins: [identity()],
      server: false,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(app.plugins.identity.asUser(request("alice")).read()).toBe(
        "bound:user:alice",
      );
      expect(app.plugins.identity.asUser(request("bob")).read()).toBe(
        "bound:user:bob",
      );
      expect(
        warn.mock.calls.filter((args) =>
          args.some(
            (arg) =>
              typeof arg === "string" &&
              arg.includes("Plugin.asUser is deprecated"),
          ),
        ),
      ).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
  test("shares one caller across shorthand, nested exports, callable handles, and run", async () => {
    await using app = await createTestApp({
      plugins: [identity(), callable()],
      server: false,
    });
    const kit = app.plugins;
    const createCaller = vi.mocked(ServiceContext.createCallerContext);
    createCaller.mockClear();
    const scoped = kit.asUser(request("alice"));
    expect(scoped.identity.read()).toBe("bound:user:alice");
    expect(scoped.identity.nested.read()).toBe("user:alice");
    expect(scoped.callable("a").read()).toBe("user:alice");
    const result = scoped.run(async (userKit) => {
      const caller = getCallerContext();
      await Promise.resolve();
      expect(userKit.identity.read()).toBe("bound:user:alice");
      expect(kit.identity.read()).toBe("bound:user:alice");
      expect(getCallerContext()).toBe(caller);
      return 42;
    });
    expectTypeOf(result).toEqualTypeOf<Promise<number>>();
    expect(await result).toBe(42);
    expect(createCaller).toHaveBeenCalledTimes(1);
    expect(kit.identity.read()).toBe("bound:app");
  });

  test("restores the parent scope after failures and isolates concurrent users", async () => {
    await using app = await createTestApp({
      plugins: [identity()],
      server: false,
    });
    const alice = app.plugins.asUser(request("alice"));
    const bob = app.plugins.asUser(request("bob"));
    await alice.run(async () => {
      await expect(bob.run((kit) => kit.identity.fail())).rejects.toThrow(
        "scope failure",
      );
      expect(getCurrentPrincipalKey()).toBe("user:alice");
    });
    const values = await Promise.all(
      [alice, bob].map((scope) =>
        scope.run(async (kit) => {
          await new Promise((resolve) => setImmediate(resolve));
          return kit.identity.read();
        }),
      ),
    );
    expect(values).toEqual(["bound:user:alice", "bound:user:bob"]);
    expect(getCurrentPrincipalKey()).toBe("app");
  });

  test("keeps shorthand streams scoped when consumed outside the original call", async () => {
    await using app = await createTestApp({
      plugins: [identity()],
      server: false,
    });
    const stream = app.plugins.asUser(request("alice")).identity.stream();
    const keys: string[] = [];
    for await (const key of stream) keys.push(key);
    expect(keys).toEqual(["user:alice", "user:alice"]);
    expect(getCurrentPrincipalKey()).toBe("app");
    const direct = app.plugins.asUser(request("bob")).identity.stream();
    expect(await direct.next()).toEqual({ done: false, value: "user:bob" });
    await direct.return();
    expect(getCurrentPrincipalKey()).toBe("app");
  });

  test("marks dev fallback without widening an existing caller scope", async () => {
    await using app = await createTestApp({
      plugins: [identity()],
      server: false,
    });
    vi.stubEnv("NODE_ENV", "development");
    const manager = new AsyncLocalStorageContextManager().enable();
    otelContext.setGlobalContextManager(manager);
    try {
      const fallback = app.plugins.asUser(createMockRequest());
      await fallback.run(() => {
        expect(getCurrentPrincipalKey()).toBe("app");
        expect(isDevOboFallback()).toBe(true);
      });
      await app.plugins.asUser(request("alice")).run(() =>
        fallback.run(() => {
          expect(getCurrentPrincipalKey()).toBe("user:alice");
          expect(isDevOboFallback()).toBe(true);
        }),
      );
      expect(isDevOboFallback()).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      otelContext.disable();
      manager.disable();
    }
  });

  test("blocks principal chaining and has no public asApp", async () => {
    await using app = await createTestApp({
      plugins: [identity()],
      server: false,
    });
    const scoped = app.plugins.asUser(request("alice"));
    expect(scoped).not.toHaveProperty("asUser");
    expect(scoped).not.toHaveProperty("asApp");
    expect(scoped.identity).not.toHaveProperty("asUser");
    expect(scoped.identity).not.toHaveProperty("asOther");
    expect(app.plugins).not.toHaveProperty("asApp");
    expectTypeOf(scoped).not.toHaveProperty("asUser");
    expectTypeOf(scoped.identity).not.toHaveProperty("asUser");
  });

  test("fails closed for missing token or user identity outside development", async () => {
    await using app = await createTestApp({
      plugins: [identity()],
      server: false,
    });
    expect(() => app.plugins.asUser(createMockRequest())).toThrow("token");
    expect(() =>
      app.plugins.asUser(
        createMockRequest({ headers: { "x-forwarded-access-token": "token" } }),
      ),
    ).toThrow();
  });

  test("partitions cache results and in-flight work by principal even with identical legacy keys", async () => {
    await using app = await createTestApp({
      plugins: [identity()],
      server: false,
    });
    const cache = CacheManager.getInstanceSync();
    const execute = vi.fn(async () => getCurrentPrincipalKey());
    const read = () =>
      cache.getOrExecute(["identity"], execute, "same-legacy-key");
    expect(await read()).toBe("app");
    const results = await Promise.all(
      ["alice", "bob", "alice"].map((user) =>
        app.plugins.asUser(request(user)).run(read),
      ),
    );
    expect(results).toEqual(["user:alice", "user:bob", "user:alice"]);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(await read()).toBe("app");
  });
});

describe("agents HTTP identity boundary", () => {
  const adapter: AgentAdapter = {
    async *run(_input, ctx) {
      const principal = getCurrentPrincipalKey();
      const toolPrincipal = await ctx.executeTool("identity.read", {});
      yield { type: "message_delta", content: `${principal}/${toolPrincipal}` };
      yield { type: "status", status: "complete" };
    },
  };

  test.each(["/invocations", "/responses", "/api/agents/chat"])(
    "%s defaults to user identity, including tool dispatch",
    async (path) => {
      await using app = await createTestApp({
        plugins: [
          identity(),
          agents({
            agents: {
              probe: {
                instructions: "Identify the caller",
                model: adapter,
                tools: (plugins) => plugins.identity.toolkit(),
              },
            },
          }),
        ],
      });
      const response = await app.post(path, {
        body: path.endsWith("chat") ? { message: "hello" } : { input: "hello" },
        obo: { userId: "alice" },
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("user:alice/user:alice");
      expect(getCurrentPrincipalKey()).toBe("app");
    },
  );

  test.each(["/invocations", "/responses", "/api/agents/chat"])(
    "%s cannot execute as SP by omitting the token",
    async (path) => {
      const run = vi.fn(adapter.run);
      await using app = await createTestApp({
        plugins: [
          identity(),
          agents({
            agents: {
              probe: { instructions: "Identify the caller", model: { run } },
            },
          }),
        ],
      });
      const response = await app.post(path, {
        body: path.endsWith("chat") ? { message: "hello" } : { input: "hello" },
        headers: { "x-forwarded-user": "alice" },
      });
      expect(response.status).toBe(401);
      expect(run).not.toHaveBeenCalled();
    },
  );
});
