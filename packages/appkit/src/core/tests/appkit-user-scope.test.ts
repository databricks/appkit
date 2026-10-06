import { Readable } from "node:stream";

import { context as otelContext } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import type { AgentAdapter, AgentToolDefinition, ToolProvider } from "shared";
import { describe, expect, expectTypeOf, test, vi } from "vitest";
import { z } from "zod";

import { CacheManager } from "../../cache";
import {
  getCallerContext,
  getCurrentPrincipalKey,
  ServiceContext,
} from "../../context";
import { isDevOboFallback } from "../../context/request-scope";
import { Plugin, toPlugin } from "../../plugin";
import { agents } from "../../plugins/agents";
import { InMemoryThreadStore } from "../../plugins/agents/thread-store";
import {
  createMockRequest,
  createMockWorkspaceClient,
  createTestApp,
} from "../../testing";
import * as workspace from "../../workspace-client";
import { tool } from "../agent/tools/tool";
import type { AgentDefinition } from "../agent/types";

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
const BYTES = [104, 105];
class DownloadPlugin extends Plugin {
  static manifest = { ...IdentityPlugin.manifest, name: "download" as const };
  exports() {
    return {
      // Files-style download: the authenticated request already ran, the
      // body is a native web stream.
      download: async () => ({
        contents: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(BYTES));
            controller.close();
          },
        }),
      }),
      nodeStream: () => Readable.from([Buffer.from(BYTES)]),
    };
  }
}
const download = toPlugin(DownloadPlugin);
class DataPlugin extends Plugin {
  static manifest = { ...IdentityPlugin.manifest, name: "data" as const };
  exports() {
    return {
      query: () => ({ rows: [{ id: 1 }], meta: { total: 1 } }),
      handle: () => ({ id: "h", read: () => getCurrentPrincipalKey() }),
      asCsv: () => "id\n1",
    };
  }
}
const data = toPlugin(DataPlugin);
const scopedSurfaces: Array<[string, (app: any) => any]> = [
  ["appkit.asUser(req)", (app) => app.plugins.asUser(request("alice")).data],
  [
    "deprecated appkit.<plugin>.asUser(req)",
    (app) => app.plugins.data.asUser(request("alice")),
  ],
];
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

  test("memoizes a plugin's scoped export per handle without crossing principals", async () => {
    await using app = await createTestApp({
      plugins: [identity()],
      server: false,
    });
    const kit = app.plugins;
    const alice = kit.asUser(request("alice"));
    const bob = kit.asUser(request("bob"));

    // Same handle: repeated access returns the identical wrapper (memoized,
    // not rebuilt on every read).
    expect(alice.identity).toBe(alice.identity);

    // Different handles: different wrappers, so one request's scoped export is
    // never shared with another principal.
    expect(alice.identity).not.toBe(bob.identity);

    // Each memoized wrapper still resolves to its own principal.
    expect(alice.identity.read()).toBe("bound:user:alice");
    expect(bob.identity.read()).toBe("bound:user:bob");
    // And again, proving the cached wrapper did not latch the first caller.
    expect(alice.identity.read()).toBe("bound:user:alice");
    expect(bob.identity.read()).toBe("bound:user:bob");
    expect(getCurrentPrincipalKey()).toBe("app");
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

  test.each([
    [
      "appkit.asUser(req)",
      (app: any) => app.plugins.asUser(request("alice")).download,
    ],
    [
      "deprecated plugin.asUser(req)",
      (app: any) => app.plugins.download.asUser(request("alice")),
    ],
  ])(
    "returns native ReadableStream downloads unchanged through %s",
    async (_, scoped) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      await using app = await createTestApp({
        plugins: [download()],
        server: false,
      });
      const { contents } = await scoped(app).download();
      expect(contents).toBeInstanceOf(ReadableStream);
      const reader = contents.getReader();
      const { value } = await reader.read();
      expect(Array.from(value)).toEqual(BYTES);
      reader.releaseLock();

      const { contents: second } = await scoped(app).download();
      await expect(second.cancel()).resolves.toBeUndefined();
    },
  );

  test("returns a Node Readable unchanged through the scoped API", async () => {
    await using app = await createTestApp({
      plugins: [download()],
      server: false,
    });
    const stream = app.plugins.asUser(request("alice")).download.nodeStream();
    expect(stream).toBeInstanceOf(Readable);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    expect(Array.from(Buffer.concat(chunks))).toEqual(BYTES);
  });

  test.each(scopedSurfaces)(
    "returns plain data results unchanged through %s",
    async (_, scoped) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      await using app = await createTestApp({
        plugins: [data()],
        server: false,
      });
      const result = scoped(app).query();
      expect(result).toEqual(app.plugins.data.query());
      expect(result.meta).toBe(result.meta);
      result.rows = [{ id: 2 }];
      expect(result.rows).toEqual([{ id: 2 }]);
    },
  );

  test.each(scopedSurfaces)(
    "still runs returned handle methods in the caller scope through %s",
    async (_, scoped) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      await using app = await createTestApp({
        plugins: [data()],
        server: false,
      });
      expect(scoped(app).handle().read()).toBe("user:alice");
      expect(app.plugins.data.handle().read()).toBe("app");
    },
  );

  test.each(scopedSurfaces)(
    "keeps non-identity as* exports callable but blocks asUser through %s",
    async (_, scoped) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      await using app = await createTestApp({
        plugins: [data()],
        server: false,
      });
      expect(scoped(app).asCsv()).toBe("id\n1");
      expect(scoped(app).asUser).toBeUndefined();
    },
  );

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
  const paths = ["/invocations", "/responses", "/api/agents/chat"];
  const body = (path: string) =>
    path.endsWith("chat") ? { message: "hello" } : { input: "hello" };

  // The model call and hand-rolled tools see the ambient principal; plugin
  // tools get user scope per call from executeTool.
  const adapter: AgentAdapter = {
    async *run(_input, ctx) {
      const model = getCurrentPrincipalKey();
      const plugin = await ctx.executeTool("identity.read", {});
      const handRolled = await ctx.executeTool("whoami", {});
      yield {
        type: "message_delta",
        content: `model=${model} plugin=${plugin} handRolled=${handRolled}`,
      };
      yield { type: "status", status: "complete" };
    },
  };
  const whoami = tool({
    description: "Report the principal seen by a hand-rolled tool",
    schema: z.object({}),
    execute: () => getCurrentPrincipalKey(),
  });

  test.each(paths)(
    "%s runs plugin tools as the user and the model and hand-rolled tools as the app",
    async (path) => {
      await using app = await createTestApp({
        plugins: [
          identity(),
          agents({
            agents: {
              probe: {
                instructions: "Identify the caller",
                model: adapter,
                tools: (plugins) => ({
                  ...plugins.identity.toolkit(),
                  whoami,
                }),
              },
            },
          }),
        ],
      });
      const response = await app.post(path, {
        body: body(path),
        obo: { userId: "alice" },
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(
        "model=app plugin=user:alice handRolled=app",
      );
      expect(getCurrentPrincipalKey()).toBe("app");
    },
  );

  test("sub-agents follow the same split", async () => {
    const parent: AgentAdapter = {
      async *run(_input, ctx) {
        const child = await ctx.executeTool("agent-child", { input: "go" });
        yield { type: "message_delta", content: `child[${child}]` };
        yield { type: "status", status: "complete" };
      },
    };
    const child: AgentDefinition = {
      instructions: "Identify the caller",
      model: adapter,
      tools: (plugins) => ({
        ...plugins.identity.toolkit(),
        whoami,
      }),
    };
    await using app = await createTestApp({
      plugins: [
        identity(),
        agents({
          agents: {
            probe: {
              default: true,
              instructions: "Delegate",
              model: parent,
              agents: { child },
            },
            child,
          },
        }),
      ],
    });
    const response = await app.post("/api/agents/chat", {
      body: { message: "hello" },
      obo: { userId: "alice" },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(
      "model=app plugin=user:alice handRolled=app",
    );
  });

  test.each(paths)(
    "%s rejects a plugin tool call without a user token and never runs it as the app",
    async (path) => {
      const executeAgentTool = vi.spyOn(
        IdentityPlugin.prototype,
        "executeAgentTool",
      );
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
        body: body(path),
        headers: { "x-forwarded-user": "alice" },
      });
      const text = await response.text();
      expect(executeAgentTool).not.toHaveBeenCalled();
      expect(text).not.toContain("plugin=app");
      executeAgentTool.mockRestore();
    },
  );
});

describe("agents on-behalf-of-user mode", () => {
  const paths = ["/invocations", "/responses", "/api/agents/chat"];
  const body = (path: string) =>
    path.endsWith("chat") ? { message: "hello" } : { input: "hello" };

  const adapter: AgentAdapter = {
    async *run(_input, ctx) {
      const model = getCurrentPrincipalKey();
      const plugin = await ctx.executeTool("identity.read", {});
      const handRolled = await ctx.executeTool("whoami", {});
      yield {
        type: "message_delta",
        content: `model=${model} plugin=${plugin} handRolled=${handRolled}`,
      };
      yield { type: "status", status: "complete" };
    },
  };
  const whoami = tool({
    description: "Report the principal seen by a hand-rolled tool",
    schema: z.object({}),
    execute: () => getCurrentPrincipalKey(),
  });
  const probe = (extra: Partial<AgentDefinition> = {}): AgentDefinition => ({
    instructions: "Identify the caller",
    model: adapter,
    tools: (plugins) => ({ ...plugins.identity.toolkit(), whoami }),
    ...extra,
  });
  const delegate: AgentAdapter = {
    async *run(_input, ctx) {
      const model = getCurrentPrincipalKey();
      const child = await ctx.executeTool("agent-child", { input: "go" });
      yield {
        type: "message_delta",
        content: `parent=${model} child[${child}]`,
      };
      yield { type: "status", status: "complete" };
    },
  };
  const userEverywhere =
    "model=user:alice plugin=user:alice handRolled=user:alice";

  test.each(paths)(
    "%s runs the model, plugin tools and hand-rolled tools as the user",
    async (path) => {
      await using app = await createTestApp({
        plugins: [
          identity(),
          agents({ auth: "on-behalf-of-user", agents: { probe: probe() } }),
        ],
      });
      const response = await app.post(path, {
        body: body(path),
        obo: { userId: "alice" },
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(userEverywhere);
      expect(getCurrentPrincipalKey()).toBe("app");
    },
  );

  test("a per-agent auth overrides the mixed plugin default", async () => {
    await using app = await createTestApp({
      plugins: [
        identity(),
        agents({
          agents: {
            probe: probe({ auth: "on-behalf-of-user", default: true }),
            mixed: probe(),
          },
        }),
      ],
    });
    const obo = await app.post("/api/agents/chat", {
      body: { message: "hello" },
      obo: { userId: "alice" },
    });
    expect(await obo.text()).toContain(userEverywhere);
    const mixed = await app.post("/api/agents/chat", {
      body: { message: "hello", agent: "mixed" },
      obo: { userId: "alice" },
    });
    expect(await mixed.text()).toContain(
      "model=app plugin=user:alice handRolled=app",
    );
  });

  test("a mixed sub-agent under an on-behalf-of-user parent never widens to the app", async () => {
    const child = probe();
    await using app = await createTestApp({
      plugins: [
        identity(),
        agents({
          agents: {
            probe: {
              default: true,
              auth: "on-behalf-of-user",
              instructions: "Delegate",
              model: delegate,
              agents: { child },
            },
            child,
          },
        }),
      ],
    });
    const response = await app.post("/api/agents/chat", {
      body: { message: "hello" },
      obo: { userId: "alice" },
    });
    expect(await response.text()).toContain(
      `parent=user:alice child[${userEverywhere}]`,
    );
  });

  test("an on-behalf-of-user sub-agent under a mixed parent runs as the user", async () => {
    const child = probe({ auth: "on-behalf-of-user" });
    await using app = await createTestApp({
      plugins: [
        identity(),
        agents({
          agents: {
            probe: {
              default: true,
              instructions: "Delegate",
              model: delegate,
              agents: { child },
            },
            child,
          },
        }),
      ],
    });
    const response = await app.post("/api/agents/chat", {
      body: { message: "hello" },
      obo: { userId: "alice" },
    });
    expect(await response.text()).toContain(
      `parent=app child[${userEverywhere}]`,
    );
  });

  test.each([
    ["production", "/invocations"],
    ["production", "/responses"],
    ["production", "/api/agents/chat"],
    ["development", "/invocations"],
    ["development", "/responses"],
    ["development", "/api/agents/chat"],
  ])(
    "%s %s returns 401 without a user token before any model or tool call",
    async (env, path) => {
      vi.stubEnv("NODE_ENV", env);
      const run = vi.fn(adapter.run);
      try {
        await using app = await createTestApp({
          plugins: [
            identity(),
            agents({
              auth: "on-behalf-of-user",
              agents: { probe: probe({ model: { run } }) },
            }),
          ],
        });
        const response = await app.post(path, {
          body: body(path),
          headers: { "x-forwarded-user": "alice" },
        });
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({
          code: "AUTHENTICATION_ERROR",
        });
        expect(run).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  test("a model 401 mid-run ends the stream with IDENTITY_EXPIRED and is not retried as the app", async () => {
    const principals: string[] = [];
    const expiring: AgentAdapter = {
      async *run() {
        principals.push(getCurrentPrincipalKey());
        yield { type: "message_delta", content: "partial" };
        throw Object.assign(new Error("upstream"), { status: 401 });
      },
    };
    await using app = await createTestApp({
      plugins: [
        identity(),
        agents({
          auth: "on-behalf-of-user",
          agents: { probe: probe({ model: expiring }) },
        }),
      ],
    });
    const streamed = await app.post("/api/agents/chat", {
      body: { message: "hello" },
      obo: { userId: "alice" },
    });
    expect(await streamed.text()).toContain("IDENTITY_EXPIRED");
    const invoked = await app.post("/invocations", {
      body: { input: "hello", stream: false },
      obo: { userId: "alice" },
    });
    expect(invoked.status).toBe(401);
    expect(await invoked.json()).toMatchObject({ code: "IDENTITY_EXPIRED" });
    expect(principals).toEqual(["user:alice", "user:alice"]);
  });

  test("thread-store writes stay the app under an on-behalf-of-user agent", async () => {
    const writers: string[] = [];
    class RecordingStore extends InMemoryThreadStore {
      override addMessage(
        ...args: Parameters<InMemoryThreadStore["addMessage"]>
      ) {
        writers.push(getCurrentPrincipalKey());
        return super.addMessage(...args);
      }
    }
    await using app = await createTestApp({
      plugins: [
        identity(),
        agents({
          auth: "on-behalf-of-user",
          threadStore: new RecordingStore(),
          agents: { probe: probe() },
        }),
      ],
    });
    const response = await app.post("/api/agents/chat", {
      body: { message: "hello" },
      obo: { userId: "alice" },
    });
    expect(await response.text()).toContain(userEverywhere);
    expect(writers.length).toBeGreaterThan(0);
    expect(new Set(writers)).toEqual(new Set(["app"]));
  });

  test.each([
    ["serving endpoint", "my-endpoint"],
    ["AI Gateway", "system.ai.claude"],
  ])(
    "a %s model string calls the model with the user client, mixed with the app client",
    async (_label, model) => {
      const used: string[] = [];
      const answer = (caller: string) =>
        (async () => {
          used.push(caller);
          return {
            contents: new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
                  ),
                );
                controller.close();
              },
            }),
          };
        }) as never;
      // The harness backs the user scope with `client`; the app's own model
      // client comes from createWorkspaceClient.
      const client = createMockWorkspaceClient();
      client.apiClient.request = answer("user");
      const real = workspace.createWorkspaceClient;
      vi.spyOn(workspace, "createWorkspaceClient").mockImplementation(
        (options) => {
          const sp = real(options);
          sp.apiClient.request = answer("app");
          return sp;
        },
      );
      try {
        await using app = await createTestApp({
          client,
          plugins: [
            agents({
              agents: {
                probe: {
                  default: true,
                  auth: "on-behalf-of-user",
                  instructions: "hi",
                  model,
                },
                mixed: { instructions: "hi", model },
              },
            }),
          ],
        });
        for (const agent of ["probe", "mixed"]) {
          const response = await app.post("/api/agents/chat", {
            body: { message: "hello", agent },
            obo: { userId: "alice" },
          });
          expect(await response.text()).toContain("ok");
        }
        expect(used).toEqual(["user", "app"]);
      } finally {
        vi.restoreAllMocks();
      }
    },
  );
});
