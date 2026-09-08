import { ApiError, files, genie } from "@databricks/appkit";
import {
  createApiError,
  createMockRequest,
  createMockResponse,
  createMockWorkspaceClient,
  createTestApp,
  createTestPlugin,
  createTestPluginContext,
  expectStream,
  getMock,
  resetTestCache,
  useServiceContextMock,
  useTestApp,
  useTestCache,
  withEnv,
} from "@databricks/appkit/testing";
import { describe, expect, test, vi } from "vitest";

import { reconnect } from "./reconnect-plugin";

/**
 * One worked example per `@databricks/appkit/testing` helper. `smoke.test.ts`
 * covers that the plugins boot and answer; this covers the kit itself.
 */

// Dummy values: the strict validator only checks the vars are present.
const FILES_ENV = {
  DATABRICKS_VOLUME_FILES: "/Volumes/main/default/vol",
  DATABRICKS_VOLUME_REPORTS: "/Volumes/main/default/vol",
};
const filesPlugin = () =>
  files({ volumes: { reports: { policy: files.policy.allowAll() } } });

describe("getMock — assert the workspace-client call a route made", () => {
  test("GET /api/files/reports/metadata calls files.getMetadata", async () => {
    await using app = await createTestApp({
      plugins: [filesPlugin()],
      env: FILES_ENV,
      responses: {
        "files.getMetadata": {
          "content-length": "42",
          "content-type": "text/plain",
        },
      },
    });

    const res = await app.get("/api/files/reports/metadata?path=report.csv");

    expect(res.status).toBe(200);
    expect(getMock(app.client, "files.getMetadata")).toHaveBeenCalled();
  });
});

describe("createMockWorkspaceClient — build the fake client yourself", () => {
  test("declared paths answer; undeclared ones resolve undefined", async () => {
    const client = createMockWorkspaceClient({
      responses: { "jobs.getRun": { state: "TERMINATED" } },
    });

    await expect(client.jobs.getRun({ run_id: 1 })).resolves.toEqual({
      state: "TERMINATED",
    });
    expect(getMock(client, "jobs.getRun")).toHaveBeenCalledWith({ run_id: 1 });
    await expect(
      client.genie.getMessage({ id: "m-1" }),
    ).resolves.toBeUndefined();
  });
});

describe("createApiError — simulate a typed workspace error", () => {
  test("produces a genuine ApiError instance", () => {
    const err = createApiError({
      statusCode: 404,
      message: "No such directory",
      errorCode: "NOT_FOUND",
    });

    expect(err).toBeInstanceOf(ApiError);
    expect(err.statusCode).toBe(404);
  });

  test("seeded as a rejection, a route surfaces the failure instead of crashing", async () => {
    await using app = await createTestApp({
      plugins: [filesPlugin()],
      env: FILES_ENV,
      responses: {
        "files.getMetadata": () => {
          throw createApiError({
            statusCode: 404,
            message: "No such file",
            errorCode: "NOT_FOUND",
          });
        },
      },
    });

    const res = await app.get("/api/files/reports/metadata?path=report.csv");

    expect(res.ok).toBe(false);
  });
});

describe("useTestApp — a fresh app per test, closed for you", () => {
  const app = useTestApp({ plugins: [reconnect()] });

  test("the first test gets its own app", async () => {
    expect((await app.current.get("/api/reconnect")).status).toBe(200);
  });

  test("the second gets a fresh one — no close() to forget", async () => {
    await expect(
      app.current.get("/api/reconnect").then((r) => r.json()),
    ).resolves.toEqual({ message: "Reconnected" });
  });
});

describe("withEnv — set env for a block, restored after", () => {
  test("the variable is present inside the block and gone after", async () => {
    expect(process.env.DEMO_FLAG).toBeUndefined();

    await withEnv({ DEMO_FLAG: "on" }, async () => {
      expect(process.env.DEMO_FLAG).toBe("on");
    });

    expect(process.env.DEMO_FLAG).toBeUndefined();
  });
});

describe("useTestCache — assert caching against the real CacheManager", () => {
  const cache = useTestCache();

  test("generateKey is stable for identical inputs and scoped per user", () => {
    const parts = ["analytics:query", "top_users"];
    expect(cache.current.generateKey(parts, "")).toBe(
      cache.current.generateKey(parts, ""),
    );
    expect(cache.current.generateKey(parts, "alice")).not.toBe(
      cache.current.generateKey(parts, "bob"),
    );
  });

  test("a second identical call is a hit; resetTestCache forces a miss", async () => {
    const work = vi.fn(async () => "value");

    await cache.current.getOrExecute(["report"], work, "");
    await cache.current.getOrExecute(["report"], work, "");
    expect(work).toHaveBeenCalledTimes(1); // second served from cache

    await resetTestCache();
    await cache.current.getOrExecute(["report"], work, "");
    expect(work).toHaveBeenCalledTimes(2); // cleared, so recomputed
  });
});

describe("createTestPlugin — instantiate a factory the way production does", () => {
  test("applies the config merge and manifest name", () => {
    const plugin = createTestPlugin(genie, { spaces: { demo: "space-test" } });

    expect(plugin.name).toBe("genie");
  });
});

describe("createTestPluginContext — unit-test wiring with no boot, no socket", () => {
  test("dispatches a cross-plugin tool call on-behalf-of the user", async () => {
    // No playground plugin dispatches tools hermetically (agents needs a live
    // model), so drive the context directly with a faked analytics tool.
    const mock = createTestPluginContext({
      analytics: { top_users: (args) => [{ user: "alice", args }] },
    });

    const req = createMockRequest({ obo: { userId: "analyst@example.com" } });
    const result = await mock.ctx.executeTool(req, "analytics", "top_users", {
      limit: 5,
    });

    expect(result).toEqual([{ user: "alice", args: { limit: 5 } }]);
    expect(mock.toolCalls[0]).toMatchObject({
      plugin: "analytics",
      tool: "top_users",
      asUser: true,
      userId: "analyst@example.com",
    });
  });

  test("a token-less request rejects on the on-behalf-of path", async () => {
    const mock = createTestPluginContext({
      analytics: { top_users: () => [] },
    });

    await expect(
      mock.ctx.executeTool(createMockRequest(), "analytics", "top_users", {}),
    ).rejects.toThrow();
  });
});

describe("expectStream — assert the ordered events a stream emits", () => {
  // reconnect's real stream is long-lived, so smoke.test.ts reads it by hand;
  // expectStream buffers to completion, so demo it on a bounded source.
  async function* runReport() {
    yield { type: "warehouse_status", state: "RUNNING" };
    yield { type: "row", n: 1 };
    yield { type: "result", rows: 1 };
  }

  test("toEmit matches an in-order subsequence", async () => {
    await expectStream(runReport()).toEmit("warehouse_status", "result");
  });

  test("toEmitExactly matches the full shape, in order", async () => {
    await expectStream(runReport()).toEmitExactly(
      "warehouse_status",
      "row",
      "result",
    );
  });

  test("reads an SSE handler's writes back through createMockResponse", async () => {
    const res = createMockResponse();
    res.setHeader("content-type", "text/event-stream");
    res.write(`event: status\ndata: ${JSON.stringify({ s: "go" })}\n\n`);
    res.write(`event: result\ndata: ${JSON.stringify({ n: 1 })}\n\n`);
    res.end();

    await expectStream(res).toEmit("status", "result");
  });
});

describe("useServiceContextMock — spy the data-plane singleton in one line", () => {
  // Spies the ServiceContext singleton directly — the seam beneath the client
  // createTestApp injects.
  const ctx = useServiceContextMock();

  test("installs live spies over the service context", () => {
    expect(ctx.current.getSpy).toBeDefined();
    expect(ctx.current.createUserContextSpy).toBeDefined();
    expect(ctx.current.createUserContextSpy).not.toHaveBeenCalled();
  });
});
