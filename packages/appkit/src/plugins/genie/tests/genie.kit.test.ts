import type express from "express";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { ServiceContext } from "../../../context";
import {
  createMockResponse,
  createTestPluginContext,
  expectStream,
} from "../../../testing";
import { type GeniePlugin, genie } from "../genie";

/**
 * Dogfooding `@databricks/appkit/testing` on a real core plugin (genie).
 *
 * Genie's `_handleSendMessage` streams SSE via the base `executeStream`. This
 * suite drives that real handler and asserts the emitted event ORDER with
 * `expectStream` — the streaming-assertion path the kit is meant to make easy.
 *
 * The kit's `createMockResponse` captures the SSE bytes the handler writes, and
 * `expectStream` reads them straight back: `expectStream(res).toEmit(...)`. No
 * hand-rolled capturing response is needed. See
 * internal/testing-kit-dogfooding.md for the wider developer-experience notes.
 */

// The base Plugin reads the cache singleton on attach; a tiny in-memory stub
// keeps this unit-level (mirrors the pattern in the sibling genie.test.ts).
const { mockCacheInstance } = vi.hoisted(() => ({
  mockCacheInstance: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    getOrExecute: vi.fn(
      async (_k: unknown[], fn: (s?: AbortSignal) => Promise<unknown>) => fn(),
    ),
    generateKey: vi.fn((...a: unknown[]) => JSON.stringify(a)),
  },
}));

vi.mock("../../../cache", () => ({
  CacheManager: { getInstanceSync: vi.fn(() => mockCacheInstance) },
}));

function mockReq(body: unknown): express.Request {
  const headers: Record<string, string> = {
    "x-forwarded-access-token": "user-token",
    "x-forwarded-user": "alice",
  };
  return {
    params: { alias: "myspace" },
    query: {},
    body,
    headers,
    header: (name: string) => headers[name.toLowerCase()],
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as express.Request;
}

describe("genie plugin — dogfooding the testing kit", () => {
  let plugin: GeniePlugin;
  let serviceContextMock: ReturnType<typeof mockServiceContextLite>;

  // A minimal ServiceContext stand-in (the kit's mockServiceContext fixture
  // covers this, but genie's streaming path only needs a resolvable context).
  function mockServiceContextLite() {
    const state = {
      client: {} as never,
      serviceUserId: "sp",
      warehouseId: Promise.resolve("wh"),
      workspaceId: Promise.resolve("ws"),
    };
    const get = vi.spyOn(ServiceContext, "get").mockReturnValue(state);
    const isInit = vi
      .spyOn(ServiceContext, "isInitialized")
      .mockReturnValue(true);
    return {
      restore: () => {
        get.mockRestore();
        isInit.mockRestore();
      },
    };
  }

  beforeEach(async () => {
    process.env.DATABRICKS_HOST = "https://test.databricks.com";
    ServiceContext.reset();
    serviceContextMock = mockServiceContextLite();

    // `genie(...)` returns a { plugin: ctor, config } descriptor for createApp;
    // for a unit test, instantiate the class and attach a real PluginContext
    // through the kit (seeds cache + flips isReady, the production path).
    const GenieCtor = genie({}).plugin as unknown as new (
      c: unknown,
    ) => GeniePlugin;
    plugin = new GenieCtor({ spaces: { myspace: "space-1" }, timeout: 5000 });
    await createTestPluginContext().attach(plugin);

    // Fake the one real edge — the network connector — to yield a known event
    // sequence. Everything else (executeStream, SSE writing) runs for real.
    (
      plugin as unknown as {
        genieConnector: {
          streamSendMessage: (...a: unknown[]) => AsyncGenerator<unknown>;
        };
      }
    ).genieConnector.streamSendMessage = async function* () {
      yield { type: "status", status: "ASKING_AI" };
      yield { type: "message", content: "Here are your results" };
      yield { type: "complete" };
    };
  });

  afterEach(() => {
    serviceContextMock.restore();
    vi.restoreAllMocks();
  });

  test("_handleSendMessage streams status -> message -> complete in order", async () => {
    const res = createMockResponse();

    await (
      plugin as unknown as {
        _handleSendMessage: (
          r: express.Request,
          w: express.Response,
        ) => Promise<void>;
      }
    )._handleSendMessage(
      mockReq({ content: "top customers?" }),
      res as unknown as express.Response,
    );

    await expectStream(res).toEmit("status", "message", "complete");
  });
});
