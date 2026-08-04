import {
  createMockRequest,
  createMockResponse,
  createMockRouter,
} from "@tools/test-helpers";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../context", () => ({
  getWorkspaceClient: vi.fn(() => mockWorkspaceClient),
  getCurrentUserId: vi.fn(() => "test-user"),
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

vi.mock("../../../cache", () => ({
  CacheManager: {
    getInstanceSync: () => ({
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
      generateKey: vi.fn(() => "test-key"),
    }),
  },
}));

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
  });

  describe("setup()", () => {
    it("throws if any index is missing indexName", async () => {
      const plugin = new AiSearchPlugin({
        indexes: {
          test: { indexName: "", columns: ["id"] },
        },
      });
      await expect(plugin.setup()).rejects.toThrow("indexName");
    });

    it("throws if any index is missing columns", async () => {
      const plugin = new AiSearchPlugin({
        indexes: {
          test: { indexName: "cat.sch.idx", columns: [] },
        },
      });
      await expect(plugin.setup()).rejects.toThrow("columns");
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
  });

  describe("manifest", () => {
    it("has correct name", () => {
      expect(AiSearchPlugin.manifest.name).toBe("ai-search");
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

      // Compile-time: `data` is typed as Doc, so these fields resolve without
      // a cast. Runtime: they carry the parsed values.
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
        expect.anything(),
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
      expect(callBody.filters).toEqual({ category: ["books"] });
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

      it("500s (via _handleError) when query preparation throws", async () => {
        // A throw *outside* execute() (here, a failing embeddingFn) reaches the
        // handler's catch → _handleError → 500. Connector failures instead flow
        // through execute() as a non-ok result with its own status.
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
          expect.anything(),
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
