import {
  createMockRequest,
  createMockResponse,
  createMockRouter,
} from "@tools/test-helpers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { withEnv } from "../../../testing";
import { Context } from "../../../workspace-client";

vi.mock("../../../context", () => ({
  getWorkspaceClient: vi.fn(() => mockWorkspaceClient),
  getCurrentUserId: vi.fn(() => "test-user"),
  // OBO plumbing so asUser() runs its non-dev path. getCurrentUserId stays
  // constant, so per-user scoping is driven by executorKey in the cacheKey.
  runInUserContext: <T>(_ctx: unknown, fn: () => T): T => fn(),
  ServiceContext: {
    createUserContext: (_token: string, userId: string) => ({
      userId,
      isUserContext: true,
    }),
  },
}));

vi.mock("../../../logging/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    event: () => ({
      setComponent: vi.fn().mockReturnThis(),
      setContext: vi.fn().mockReturnThis(),
      setExecution: vi.fn().mockReturnThis(),
    }),
  }),
}));

vi.mock("../../../telemetry", () => ({
  TelemetryManager: {
    getProvider: () => ({
      getTracer: () => ({}),
      getMeter: () => ({
        createCounter: () => ({ add: vi.fn() }),
        createHistogram: () => ({ record: vi.fn() }),
      }),
      startActiveSpan: vi.fn(
        (
          _name: string,
          _opts: unknown,
          fn: (...args: unknown[]) => unknown,
          _telemetryOpts?: unknown,
        ) =>
          fn({
            setAttribute: vi.fn(),
            setStatus: vi.fn(),
            recordException: vi.fn(),
          }),
      ),
    }),
  },
  SpanKind: { CLIENT: 3 },
  SpanStatusCode: { OK: 1, ERROR: 2 },
  normalizeTelemetryOptions: () => ({ traces: false, metrics: false }),
}));

// In-memory cache keyed like the real CacheManager.generateKey, so tests
// exercise real key composition. Never stores rejections.
const { mockCacheStore } = vi.hoisted(() => ({
  mockCacheStore: new Map<string, unknown>(),
}));

vi.mock("../../../cache", () => {
  const keyOf = (parts: unknown[], userKey: string) =>
    JSON.stringify([userKey, ...parts]);
  return {
    CacheManager: {
      getInstanceSync: () => ({
        get: vi.fn(),
        set: vi.fn(),
        delete: vi.fn(),
        generateKey: keyOf,
        getOrExecute: async (
          key: unknown[],
          fn: (signal?: AbortSignal) => Promise<unknown>,
          userKey: string,
        ) => {
          const k = keyOf(key, userKey);
          if (mockCacheStore.has(k)) return mockCacheStore.get(k);
          const result = await fn();
          mockCacheStore.set(k, result);
          return result;
        },
      }),
    },
  };
});

vi.mock("../../../app", () => ({
  AppManager: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("../../../plugin/dev-reader", () => ({
  DevFileReader: {
    getInstance: () => ({}),
  },
}));

vi.mock("../../../stream", () => ({
  StreamManager: vi.fn().mockImplementation(() => ({
    abortAll: vi.fn(),
    stream: vi.fn(),
  })),
}));

const validVsResponse = {
  manifest: {
    column_count: 3,
    columns: [{ name: "id" }, { name: "title" }, { name: "score" }],
  },
  result: {
    row_count: 2,
    data_array: [
      [1, "ML Guide", 0.95],
      [2, "AI Primer", 0.87],
    ],
  },
  next_page_token: null,
  debug_info: { response_time: 35 },
};

const mockRequest = vi.fn().mockResolvedValue(validVsResponse);
const mockWorkspaceClient = {
  apiClient: { request: mockRequest },
};

import { AiSearchPlugin } from "../ai-search";

describe("AiSearchPlugin", () => {
  beforeEach(() => {
    mockRequest.mockClear();
    mockRequest.mockResolvedValue(validVsResponse);
    mockCacheStore.clear();
  });

  describe("setup()", () => {
    const originalIndexEnv = process.env.DATABRICKS_VS_INDEX_NAME;
    afterEach(() => {
      if (originalIndexEnv === undefined) {
        delete process.env.DATABRICKS_VS_INDEX_NAME;
      } else {
        process.env.DATABRICKS_VS_INDEX_NAME = originalIndexEnv;
      }
    });

    it("defaults indexName from DATABRICKS_VS_INDEX_NAME when omitted", async () => {
      process.env.DATABRICKS_VS_INDEX_NAME = "cat.sch.from_env";
      const plugin = new AiSearchPlugin({
        indexes: {
          test: { columns: ["id"] },
        },
      });
      await expect(plugin.setup()).resolves.not.toThrow();

      await plugin.query("test", { queryText: "q" });
      expect(mockRequest.mock.calls[0][0].path).toBe(
        "/api/2.0/vector-search/indexes/cat.sch.from_env/query",
      );
    });

    it("seeds a 'default' index from the env var when no indexes are configured", async () => {
      process.env.DATABRICKS_VS_INDEX_NAME = "cat.sch.from_env";
      // Bare aiSearch() — no indexes config.
      const plugin = new AiSearchPlugin({});

      await plugin.query("default", { queryText: "q", columns: ["id"] });
      expect(mockRequest.mock.calls[0][0].path).toBe(
        "/api/2.0/vector-search/indexes/cat.sch.from_env/query",
      );
    });

    it("throws if pagination enabled but no endpointName", async () => {
      const plugin = new AiSearchPlugin({
        indexes: {
          test: {
            indexName: "cat.sch.idx",
            columns: ["id"],
            pagination: true,
          },
        },
      });
      await expect(plugin.setup()).rejects.toThrow("endpointName");
    });

    it("succeeds with valid config", async () => {
      const plugin = new AiSearchPlugin({
        indexes: {
          products: {
            indexName: "cat.sch.products_idx",
            columns: ["id", "name", "description"],
            queryType: "hybrid",
            numResults: 20,
          },
        },
      });
      await expect(plugin.setup()).resolves.not.toThrow();
    });

    it("throws outside development when an index has no columns", async () => {
      await withEnv({ NODE_ENV: "production" }, async () => {
        const plugin = new AiSearchPlugin({
          indexes: { docs: { indexName: "cat.sch.idx" } },
        });
        await expect(plugin.setup()).rejects.toThrow(
          'Index "docs" has no columns configured',
        );
      });
    });

    it("does not throw outside development when columns are configured", async () => {
      await withEnv({ NODE_ENV: "production" }, async () => {
        const plugin = new AiSearchPlugin({
          indexes: { docs: { indexName: "cat.sch.idx", columns: ["id"] } },
        });
        await expect(plugin.setup()).resolves.not.toThrow();
      });
    });
  });

  describe("setup() column auto-discovery", () => {
    const originalNodeEnv = process.env.NODE_ENV;
    // Route GET metadata calls to discovery fixtures; POST queries stay on the
    // default validVsResponse.
    const routeByPath = (opts: { method: string; path: string }) => {
      if (opts.path.endsWith("/query")) return Promise.resolve(validVsResponse);
      if (opts.path.startsWith("/api/2.0/vector-search/indexes/")) {
        return Promise.resolve({
          index_type: "DELTA_SYNC",
          delta_sync_index_spec: {
            source_table: "cat.sch.src",
            embedding_vector_columns: [{ name: "__vec" }],
          },
        });
      }
      if (opts.path.startsWith("/api/2.1/unity-catalog/tables/")) {
        return Promise.resolve({
          columns: [{ name: "id" }, { name: "body" }, { name: "__vec" }],
        });
      }
      return Promise.resolve(validVsResponse);
    };

    afterEach(() => {
      process.env.NODE_ENV = originalNodeEnv;
    });

    it("fills columns from the source table in development and warns", async () => {
      process.env.NODE_ENV = "development";
      mockRequest.mockImplementation(routeByPath);
      const plugin = new AiSearchPlugin({
        indexes: { docs: { indexName: "cat.sch.idx" } },
      });

      await plugin.setup();

      // Discovered columns, minus the embedding vector column.
      await plugin.query("docs", { queryText: "q" });
      const queryCall = mockRequest.mock.calls.find((c) =>
        c[0].path.endsWith("/query"),
      );
      expect(queryCall?.[0].payload.columns).toEqual(["id", "body"]);
    });

    it("does not discover columns outside development", async () => {
      process.env.NODE_ENV = "production";
      mockRequest.mockImplementation(routeByPath);
      // Columns set so the prod no-columns guard doesn't fire; this test only
      // asserts discovery doesn't run outside development.
      const plugin = new AiSearchPlugin({
        indexes: { docs: { indexName: "cat.sch.idx", columns: ["id"] } },
      });

      await plugin.setup();

      // No get-index / get-table calls were made.
      const metadataCalls = mockRequest.mock.calls.filter(
        (c) => !c[0].path.endsWith("/query"),
      );
      expect(metadataCalls).toHaveLength(0);
    });

    it("skips (does not throw) when an index already has columns", async () => {
      process.env.NODE_ENV = "development";
      mockRequest.mockImplementation(routeByPath);
      const plugin = new AiSearchPlugin({
        indexes: { docs: { indexName: "cat.sch.idx", columns: ["id"] } },
      });

      await plugin.setup();

      const metadataCalls = mockRequest.mock.calls.filter(
        (c) => !c[0].path.endsWith("/query"),
      );
      expect(metadataCalls).toHaveLength(0);
    });
  });

  describe("manifest", () => {
    it("has correct name", () => {
      expect(AiSearchPlugin.manifest.name).toBe("aiSearch");
    });
  });

  describe("exports()", () => {
    it("returns object with query function", () => {
      const plugin = new AiSearchPlugin({
        indexes: {
          test: { indexName: "cat.sch.idx", columns: ["id"] },
        },
      });
      const exports = plugin.exports();
      expect(exports).toHaveProperty("query");
      expect(typeof exports.query).toBe("function");
    });
  });

  describe("query()", () => {
    it("calls VS API via connector and parses response", async () => {
      const plugin = new AiSearchPlugin({
        indexes: {
          products: {
            indexName: "cat.sch.products",
            columns: ["id", "title"],
            queryType: "hybrid",
          },
        },
      });
      await plugin.setup();

      const result = await plugin.query("products", {
        queryText: "machine learning",
      });

      expect(result.results).toHaveLength(2);
      expect(result.results[0].score).toBe(0.95);
      expect(result.results[0].data).toEqual({ id: 1, title: "ML Guide" });
      expect(result.results[1].score).toBe(0.87);
      expect(result.totalCount).toBe(2);
      expect(result.queryTimeMs).toBe(35);
    });

    it("types result.data via the generic parameter", async () => {
      interface Doc extends Record<string, unknown> {
        id: number;
        title: string;
      }
      const plugin = new AiSearchPlugin({
        indexes: {
          products: { indexName: "cat.sch.products", columns: ["id", "title"] },
        },
      });
      await plugin.setup();

      const result = await plugin.query<Doc>("products", {
        queryText: "machine learning",
      });

      // `data` is typed as Doc — these fields resolve without a cast.
      const first: Doc = result.results[0].data;
      expect(first.id).toBe(1);
      expect(first.title).toBe("ML Guide");
    });

    it("constructs correct API request", async () => {
      const plugin = new AiSearchPlugin({
        indexes: {
          test: {
            indexName: "cat.sch.idx",
            columns: ["id", "title"],
            queryType: "hybrid",
            numResults: 10,
          },
        },
      });
      await plugin.setup();
      await plugin.query("test", { queryText: "test query" });

      expect(mockRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "POST",
          path: "/api/2.0/vector-search/indexes/cat.sch.idx/query",
        }),
        // 2nd arg is the SDK Context bridging the execution's abort signal.
        expect.any(Context),
      );

      const callBody = mockRequest.mock.calls[0][0].payload;
      expect(callBody.query_text).toBe("test query");
      expect(callBody.query_type).toBe("HYBRID");
      expect(callBody.num_results).toBe(10);
      expect(callBody.columns).toEqual(["id", "title"]);
    });

    it("throws Error for unknown alias", async () => {
      const plugin = new AiSearchPlugin({
        indexes: {
          test: { indexName: "cat.sch.idx", columns: ["id"] },
        },
      });
      await plugin.setup();

      await expect(
        plugin.query("unknown", { queryText: "test" }),
      ).rejects.toThrow('No index configured with alias "unknown"');
    });

    it("includes filters when provided", async () => {
      const plugin = new AiSearchPlugin({
        indexes: {
          test: {
            indexName: "cat.sch.idx",
            columns: ["id", "title"],
          },
        },
      });
      await plugin.setup();
      await plugin.query("test", {
        queryText: "test",
        filters: { category: ["books"] },
      });

      const callBody = mockRequest.mock.calls[0][0].payload;
      // VS expects a JSON-encoded string under `filters_json`; a raw object
      // under `filters` is silently ignored by the API.
      expect(callBody.filters).toBeUndefined();
      expect(callBody.filters_json).toBe(
        JSON.stringify({ category: ["books"] }),
      );
    });

    it("includes reranker config when enabled on index", async () => {
      const plugin = new AiSearchPlugin({
        indexes: {
          test: {
            indexName: "cat.sch.idx",
            columns: ["id", "title", "desc"],
            reranker: true,
          },
        },
      });
      await plugin.setup();
      await plugin.query("test", { queryText: "test" });

      const callBody = mockRequest.mock.calls[0][0].payload;
      expect(callBody.reranker.model).toBe("databricks_reranker");
      expect(callBody.reranker.parameters.columns_to_rerank).toEqual([
        "title",
        "desc",
      ]);
    });

    it("calls embeddingFn and drops query_text for ann (vector-only)", async () => {
      const mockEmbeddingFn = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);
      const plugin = new AiSearchPlugin({
        indexes: {
          test: {
            indexName: "cat.sch.idx",
            columns: ["id", "title"],
            queryType: "ann",
            embeddingFn: mockEmbeddingFn,
          },
        },
      });
      await plugin.setup();
      await plugin.query("test", { queryText: "test" });

      expect(mockEmbeddingFn).toHaveBeenCalledWith("test");
      const callBody = mockRequest.mock.calls[0][0].payload;
      expect(callBody.query_vector).toEqual([0.1, 0.2, 0.3]);
      expect(callBody.query_text).toBeUndefined();
    });

    it("keeps query_text alongside the embedded vector for hybrid", async () => {
      const mockEmbeddingFn = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);
      const plugin = new AiSearchPlugin({
        indexes: {
          test: {
            indexName: "cat.sch.idx",
            columns: ["id", "title"],
            queryType: "hybrid",
            embeddingFn: mockEmbeddingFn,
          },
        },
      });
      await plugin.setup();
      await plugin.query("test", { queryText: "test" });

      expect(mockEmbeddingFn).toHaveBeenCalledWith("test");
      const callBody = mockRequest.mock.calls[0][0].payload;
      expect(callBody.query_vector).toEqual([0.1, 0.2, 0.3]);
      expect(callBody.query_text).toBe("test");
    });

    it("skips embeddingFn for full_text and sends query_text only", async () => {
      const mockEmbeddingFn = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);
      const plugin = new AiSearchPlugin({
        indexes: {
          test: {
            indexName: "cat.sch.idx",
            columns: ["id", "title"],
            queryType: "full_text",
            embeddingFn: mockEmbeddingFn,
          },
        },
      });
      await plugin.setup();
      await plugin.query("test", { queryText: "test" });

      expect(mockEmbeddingFn).not.toHaveBeenCalled();
      const callBody = mockRequest.mock.calls[0][0].payload;
      expect(callBody.query_text).toBe("test");
      expect(callBody.query_vector).toBeUndefined();
    });

    it("throws when embeddingFn fails", async () => {
      const mockEmbeddingFn = vi
        .fn()
        .mockRejectedValue(new Error("embedding service unavailable"));
      const plugin = new AiSearchPlugin({
        indexes: {
          test: {
            indexName: "cat.sch.idx",
            columns: ["id", "title"],
            embeddingFn: mockEmbeddingFn,
          },
        },
      });
      await plugin.setup();

      await expect(plugin.query("test", { queryText: "test" })).rejects.toThrow(
        "Embedding generation failed",
      );
    });
  });

  describe("shutdown()", () => {
    it("does not throw", async () => {
      const plugin = new AiSearchPlugin({
        indexes: {
          test: { indexName: "cat.sch.idx", columns: ["id"] },
        },
      });
      await expect(plugin.shutdown()).resolves.not.toThrow();
    });
  });

  describe("_parseResponse edge cases", () => {
    it("defaults score to 0 when the index returns no score column", async () => {
      mockRequest.mockResolvedValueOnce({
        manifest: { column_count: 2, columns: [{ name: "id" }, { name: "t" }] },
        result: { row_count: 1, data_array: [[1, "hi"]] },
        next_page_token: null,
      });
      const plugin = new AiSearchPlugin({
        indexes: { test: { indexName: "cat.sch.idx", columns: ["id", "t"] } },
      });
      await plugin.setup();
      const res = await plugin.query("test", { queryText: "q" });

      expect(res.results[0].score).toBe(0);
      expect(res.results[0].data).toEqual({ id: 1, t: "hi" });
    });

    it("propagates a non-null next_page_token", async () => {
      mockRequest.mockResolvedValueOnce({
        ...validVsResponse,
        next_page_token: "tok-123",
      });
      const plugin = new AiSearchPlugin({
        indexes: { test: { indexName: "cat.sch.idx", columns: ["id"] } },
      });
      await plugin.setup();
      const res = await plugin.query("test", { queryText: "q" });

      expect(res.nextPageToken).toBe("tok-123");
    });

    it("falls back to latency_ms for queryTimeMs when response_time is absent", async () => {
      mockRequest.mockResolvedValueOnce({
        manifest: { column_count: 1, columns: [{ name: "id" }] },
        result: { row_count: 0, data_array: [] },
        next_page_token: null,
        debug_info: { latency_ms: 42 },
      });
      const plugin = new AiSearchPlugin({
        indexes: { test: { indexName: "cat.sch.idx", columns: ["id"] } },
      });
      await plugin.setup();
      const res = await plugin.query("test", { queryText: "q" });

      expect(res.queryTimeMs).toBe(42);
      expect(res.results).toEqual([]);
      expect(res.totalCount).toBe(0);
    });
  });

  describe("query() overrides and reranker", () => {
    it("lets the request override index queryType, numResults, and columns", async () => {
      const plugin = new AiSearchPlugin({
        indexes: {
          test: {
            indexName: "cat.sch.idx",
            columns: ["id", "title"],
            queryType: "hybrid",
            numResults: 10,
          },
        },
      });
      await plugin.setup();
      await plugin.query("test", {
        queryText: "q",
        queryType: "ann",
        numResults: 5,
        columns: ["id"],
      });

      const callBody = mockRequest.mock.calls[0][0].payload;
      expect(callBody.query_type).toBe("ANN");
      expect(callBody.num_results).toBe(5);
      expect(callBody.columns).toEqual(["id"]);
    });

    it("passes an object reranker through untouched", async () => {
      const plugin = new AiSearchPlugin({
        indexes: {
          test: {
            indexName: "cat.sch.idx",
            columns: ["id", "title", "body"],
            reranker: { columnsToRerank: ["title"] },
          },
        },
      });
      await plugin.setup();
      await plugin.query("test", { queryText: "q" });

      const callBody = mockRequest.mock.calls[0][0].payload;
      expect(callBody.reranker.parameters.columns_to_rerank).toEqual(["title"]);
    });

    it("lets request.reranker=false suppress an index-enabled reranker", async () => {
      const plugin = new AiSearchPlugin({
        indexes: {
          test: {
            indexName: "cat.sch.idx",
            columns: ["id", "title"],
            reranker: true,
          },
        },
      });
      await plugin.setup();
      await plugin.query("test", { queryText: "q", reranker: false });

      const callBody = mockRequest.mock.calls[0][0].payload;
      expect(callBody.reranker).toBeUndefined();
    });

    it("skips the reranker when enabled but no columns are resolved", async () => {
      // Query-time behavior only; skip setup() (its prod guard rejects the
      // deliberately column-less config used to exercise this path).
      const plugin = new AiSearchPlugin({
        indexes: { test: { indexName: "cat.sch.idx", reranker: true } },
      });
      await plugin.query("test", { queryText: "q" });

      const callBody = mockRequest.mock.calls[0][0].payload;
      expect(callBody.reranker).toBeUndefined();
      expect(callBody.columns).toEqual([]);
    });

    it("throws a wrapped error when the connector query fails", async () => {
      // Persistent reject so the retry interceptor exhausts its attempts and
      // execute() surfaces a failed result, driving the !result.ok branch.
      mockRequest.mockRejectedValue(new Error("VS 503"));
      const plugin = new AiSearchPlugin({
        indexes: { products: { indexName: "cat.sch.p", columns: ["id"] } },
      });
      await plugin.setup();

      await expect(
        plugin.query("products", { queryText: "q" }),
      ).rejects.toThrow(/Vector search query failed for index "products"/);
    });
  });

  describe("caching", () => {
    const makePlugin = () =>
      new AiSearchPlugin({
        indexes: {
          products: {
            indexName: "cat.sch.products",
            columns: ["id", "title"],
            queryType: "hybrid",
            numResults: 10,
          },
        },
      });

    it("serves an identical query from cache (connector called once)", async () => {
      const plugin = makePlugin();
      await plugin.setup();

      await plugin.query("products", { queryText: "machine learning" });
      await plugin.query("products", { queryText: "machine learning" });

      expect(mockRequest).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["queryText", { queryText: "different" }],
      ["numResults", { queryText: "q", numResults: 5 }],
      ["queryType", { queryText: "q", queryType: "ann" as const }],
      ["columns", { queryText: "q", columns: ["id"] }],
      ["filters", { queryText: "q", filters: { category: ["books"] } }],
      ["reranker", { queryText: "q", reranker: true }],
    ])(
      "does not share cache entries when %s differs (2 connector calls)",
      async (_field, second) => {
        const plugin = makePlugin();
        await plugin.setup();

        await plugin.query("products", { queryText: "q" });
        await plugin.query("products", second);

        expect(mockRequest).toHaveBeenCalledTimes(2);
      },
    );

    it("shares a cache entry for filters that differ only in key order", async () => {
      const plugin = makePlugin();
      await plugin.setup();

      // Same filter semantics, different key insertion order — must hit the
      // same entry (the key stable-stringifies object keys).
      await plugin.query("products", {
        queryText: "q",
        filters: { category: ["books"], inStock: true },
      });
      await plugin.query("products", {
        queryText: "q",
        filters: { inStock: true, category: ["books"] },
      });

      expect(mockRequest).toHaveBeenCalledTimes(1);
    });

    it("still splits entries when filter values differ", async () => {
      const plugin = makePlugin();
      await plugin.setup();

      // Guard against over-merging: only key ORDER is normalized, not values.
      await plugin.query("products", {
        queryText: "q",
        filters: { category: ["books"] },
      });
      await plugin.query("products", {
        queryText: "q",
        filters: { category: ["films"] },
      });

      expect(mockRequest).toHaveBeenCalledTimes(2);
    });

    it("shares a cache entry for the same columns in a different order", async () => {
      const plugin = makePlugin();
      await plugin.setup();

      // columns is a projection list — order doesn't change results, so a
      // reordered projection must reuse the entry (key sorts a copy).
      await plugin.query("products", {
        queryText: "q",
        columns: ["id", "title"],
      });
      await plugin.query("products", {
        queryText: "q",
        columns: ["title", "id"],
      });

      expect(mockRequest).toHaveBeenCalledTimes(1);
    });

    it("keys managed-embedding queries by queryText, skipping embedding on a route cache hit", async () => {
      // Keyed by queryText, not the derived vector; the hit skips embeddingFn.
      const embeddingFn = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);
      const plugin = new AiSearchPlugin({
        indexes: {
          docs: {
            indexName: "cat.sch.docs",
            columns: ["id", "title"],
            queryType: "ann",
            embeddingFn,
          },
        },
      });
      await plugin.setup();

      const { router, getHandler } = createMockRouter();
      plugin.injectRoutes(router);
      const handler = getHandler("POST", "/:alias/query");
      const run = () =>
        handler(
          createMockRequest({
            params: { alias: "docs" },
            body: { queryText: "same" },
          }),
          createMockResponse(),
        );

      await run();
      await run();

      expect(mockRequest).toHaveBeenCalledTimes(1);
      expect(embeddingFn).toHaveBeenCalledTimes(1);
    });

    it("skips embedding on a programmatic query() cache hit too", async () => {
      const embeddingFn = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);
      const plugin = new AiSearchPlugin({
        indexes: {
          docs: {
            indexName: "cat.sch.docs",
            columns: ["id", "title"],
            queryType: "ann",
            embeddingFn,
          },
        },
      });
      await plugin.setup();

      await plugin.query("docs", { queryText: "same" });
      await plugin.query("docs", { queryText: "same" });

      expect(mockRequest).toHaveBeenCalledTimes(1);
      expect(embeddingFn).toHaveBeenCalledTimes(1);
    });

    it("does not share cache across OBO users (per-user cache key)", async () => {
      const plugin = new AiSearchPlugin({
        indexes: {
          docs: {
            indexName: "cat.sch.docs",
            columns: ["id", "title"],
            auth: "on-behalf-of-user",
          },
        },
      });
      await plugin.setup();

      const { router, getHandler } = createMockRouter();
      plugin.injectRoutes(router);
      const handler = getHandler("POST", "/:alias/query");

      const runAs = async (user: string) => {
        const res = createMockResponse();
        await handler(
          createMockRequest({
            params: { alias: "docs" },
            body: { queryText: "shared question" },
            headers: {
              "x-forwarded-user": user,
              "x-forwarded-access-token": "tok",
            },
          }),
          res,
        );
        return res;
      };

      const resA = await runAs("alice");
      const resB = await runAs("bob");

      // Same query text, different users → distinct keys → both hit the
      // connector. A shared entry would collapse this to one call and leak
      // alice's results to bob.
      expect(mockRequest).toHaveBeenCalledTimes(2);
      expect(resA.json).toHaveBeenCalled();
      expect(resB.json).toHaveBeenCalled();
    });

    it("re-serves the same OBO user from cache (connector called once)", async () => {
      const plugin = new AiSearchPlugin({
        indexes: {
          docs: {
            indexName: "cat.sch.docs",
            columns: ["id", "title"],
            auth: "on-behalf-of-user",
          },
        },
      });
      await plugin.setup();

      const { router, getHandler } = createMockRouter();
      plugin.injectRoutes(router);
      const handler = getHandler("POST", "/:alias/query");

      const runAsAlice = () =>
        handler(
          createMockRequest({
            params: { alias: "docs" },
            body: { queryText: "shared question" },
            headers: {
              "x-forwarded-user": "alice",
              "x-forwarded-access-token": "tok",
            },
          }),
          createMockResponse(),
        );

      await runAsAlice();
      await runAsAlice();

      expect(mockRequest).toHaveBeenCalledTimes(1);
    });
  });

  describe("injectRoutes", () => {
    const makePlugin = () =>
      new AiSearchPlugin({
        indexes: {
          demo: {
            indexName: "cat.sch.idx",
            columns: ["id", "title"],
            queryType: "hybrid",
          },
          paged: {
            indexName: "cat.sch.paged",
            columns: ["id"],
            pagination: true,
            endpointName: "ep",
          },
        },
      });

    it("registers the three routes", () => {
      const plugin = makePlugin();
      const { router } = createMockRouter();
      plugin.injectRoutes(router);

      expect(router.post).toHaveBeenCalledWith(
        "/:alias/query",
        expect.any(Function),
      );
      expect(router.post).toHaveBeenCalledWith(
        "/:alias/next-page",
        expect.any(Function),
      );
      expect(router.get).toHaveBeenCalledWith(
        "/:alias/config",
        expect.any(Function),
      );
    });

    describe("/:alias/query", () => {
      it("404s an unknown alias", async () => {
        const plugin = makePlugin();
        const { router, getHandler } = createMockRouter();
        plugin.injectRoutes(router);

        const res = createMockResponse();
        await getHandler("POST", "/:alias/query")(
          createMockRequest({ params: { alias: "nope" }, body: {} }),
          res,
        );

        expect(res.status).toHaveBeenCalledWith(404);
      });

      it("400s when neither queryText nor queryVector is provided", async () => {
        const plugin = makePlugin();
        const { router, getHandler } = createMockRouter();
        plugin.injectRoutes(router);

        const res = createMockResponse();
        await getHandler("POST", "/:alias/query")(
          createMockRequest({ params: { alias: "demo" }, body: {} }),
          res,
        );

        expect(res.status).toHaveBeenCalledWith(400);
      });

      it("returns the parsed response on success", async () => {
        const plugin = makePlugin();
        const { router, getHandler } = createMockRouter();
        plugin.injectRoutes(router);

        const res = createMockResponse();
        await getHandler("POST", "/:alias/query")(
          createMockRequest({
            params: { alias: "demo" },
            body: { queryText: "hi" },
          }),
          res,
        );

        expect(res.json).toHaveBeenCalledWith(
          expect.objectContaining({ totalCount: 2, queryType: "hybrid" }),
        );
      });

      it("ignores a client-supplied columns override and uses the configured projection", async () => {
        const plugin = makePlugin();
        const { router, getHandler } = createMockRouter();
        plugin.injectRoutes(router);

        const res = createMockResponse();
        await getHandler("POST", "/:alias/query")(
          createMockRequest({
            params: { alias: "demo" },
            body: { queryText: "hi", columns: ["ssn", "internal_notes"] },
          }),
          res,
        );

        // demo is configured with columns ["id", "title"]; the request's
        // columns must not widen the projection.
        const callBody = mockRequest.mock.calls[0][0].payload;
        expect(callBody.columns).toEqual(["id", "title"]);
      });

      it("500s when query preparation throws", async () => {
        // Query prep (embeddingFn) runs inside execute() so it shares the OBO
        // context; a failure surfaces as a non-ok result → 500.
        const plugin = new AiSearchPlugin({
          indexes: {
            demo: {
              indexName: "cat.sch.idx",
              columns: ["id", "title"],
              queryType: "ann",
              embeddingFn: vi.fn().mockRejectedValue(new Error("embed down")),
            },
          },
        });
        const { router, getHandler } = createMockRouter();
        plugin.injectRoutes(router);

        const res = createMockResponse();
        await getHandler("POST", "/:alias/query")(
          createMockRequest({
            params: { alias: "demo" },
            body: { queryText: "hi" },
          }),
          res,
        );

        expect(res.status).toHaveBeenCalledWith(500);
      });
    });

    describe("/:alias/next-page", () => {
      it("400s when pagination is not enabled", async () => {
        const plugin = makePlugin();
        const { router, getHandler } = createMockRouter();
        plugin.injectRoutes(router);

        const res = createMockResponse();
        await getHandler("POST", "/:alias/next-page")(
          createMockRequest({
            params: { alias: "demo" },
            body: { pageToken: "t" },
          }),
          res,
        );

        expect(res.status).toHaveBeenCalledWith(400);
      });

      it("400s when pageToken is missing", async () => {
        const plugin = makePlugin();
        const { router, getHandler } = createMockRouter();
        plugin.injectRoutes(router);

        const res = createMockResponse();
        await getHandler("POST", "/:alias/next-page")(
          createMockRequest({ params: { alias: "paged" }, body: {} }),
          res,
        );

        expect(res.status).toHaveBeenCalledWith(400);
      });

      it("fetches the next page on success", async () => {
        const plugin = makePlugin();
        const { router, getHandler } = createMockRouter();
        plugin.injectRoutes(router);

        const res = createMockResponse();
        await getHandler("POST", "/:alias/next-page")(
          createMockRequest({
            params: { alias: "paged" },
            body: { pageToken: "t" },
          }),
          res,
        );

        expect(mockRequest).toHaveBeenCalledWith(
          expect.objectContaining({
            path: "/api/2.0/vector-search/indexes/cat.sch.paged/query-next-page",
            payload: { endpoint_name: "ep", page_token: "t" },
          }),
          expect.any(Context),
        );
        expect(res.json).toHaveBeenCalled();
      });
    });

    describe("/:alias/config", () => {
      it("404s an unknown alias", async () => {
        const plugin = makePlugin();
        const { router, getHandler } = createMockRouter();
        plugin.injectRoutes(router);

        const res = createMockResponse();
        await getHandler("GET", "/:alias/config")(
          createMockRequest({ params: { alias: "nope" } }),
          res,
        );

        expect(res.status).toHaveBeenCalledWith(404);
      });

      it("returns resolved config with defaults", async () => {
        const plugin = makePlugin();
        const { router, getHandler } = createMockRouter();
        plugin.injectRoutes(router);

        const res = createMockResponse();
        await getHandler("GET", "/:alias/config")(
          createMockRequest({ params: { alias: "demo" } }),
          res,
        );

        expect(res.json).toHaveBeenCalledWith({
          alias: "demo",
          columns: ["id", "title"],
          queryType: "hybrid",
          numResults: 20,
          reranker: false,
          pagination: false,
        });
      });
    });
  });
});
