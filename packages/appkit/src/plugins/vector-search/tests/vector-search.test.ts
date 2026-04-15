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

import { VectorSearchPlugin } from "../vector-search";

describe("VectorSearchPlugin", () => {
  beforeEach(() => {
    mockRequest.mockClear();
    mockRequest.mockResolvedValue(validVsResponse);
  });

  describe("setup()", () => {
    it("throws if any index is missing indexName", async () => {
      const plugin = new VectorSearchPlugin({
        indexes: {
          test: { indexName: "", columns: ["id"] },
        },
      });
      await expect(plugin.setup()).rejects.toThrow("indexName");
    });

    it("throws if any index is missing columns", async () => {
      const plugin = new VectorSearchPlugin({
        indexes: {
          test: { indexName: "cat.sch.idx", columns: [] },
        },
      });
      await expect(plugin.setup()).rejects.toThrow("columns");
    });

    it("throws if pagination enabled but no endpointName", async () => {
      const plugin = new VectorSearchPlugin({
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
      const plugin = new VectorSearchPlugin({
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
      expect(VectorSearchPlugin.manifest.name).toBe("vector-search");
    });
  });

  describe("exports()", () => {
    it("returns object with query function", () => {
      const plugin = new VectorSearchPlugin({
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
      const plugin = new VectorSearchPlugin({
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

    it("constructs correct API request", async () => {
      const plugin = new VectorSearchPlugin({
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
      );

      const callBody = mockRequest.mock.calls[0][0].payload;
      expect(callBody.query_text).toBe("test query");
      expect(callBody.query_type).toBe("HYBRID");
      expect(callBody.num_results).toBe(10);
      expect(callBody.columns).toEqual(["id", "title"]);
    });

    it("throws Error for unknown alias", async () => {
      const plugin = new VectorSearchPlugin({
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
      const plugin = new VectorSearchPlugin({
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
      const plugin = new VectorSearchPlugin({
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

    it("calls embeddingFn for self-managed indexes", async () => {
      const mockEmbeddingFn = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);
      const plugin = new VectorSearchPlugin({
        indexes: {
          test: {
            indexName: "cat.sch.idx",
            columns: ["id", "title"],
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

    it("throws when embeddingFn fails", async () => {
      const mockEmbeddingFn = vi
        .fn()
        .mockRejectedValue(new Error("embedding service unavailable"));
      const plugin = new VectorSearchPlugin({
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
      const plugin = new VectorSearchPlugin({
        indexes: {
          test: { indexName: "cat.sch.idx", columns: ["id"] },
        },
      });
      await expect(plugin.shutdown()).resolves.not.toThrow();
    });
  });
});
