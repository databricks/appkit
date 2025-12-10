import type { sql } from "@databricks/sdk-experimental";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ArrowStreamProcessor } from "../arrow-stream-processor";

type ResultSchema = sql.ResultManifest["schema"];

// Mock apache-arrow module
vi.mock("apache-arrow", () => {
  const mockSchema = {
    fields: [
      { name: "id", type: { toString: () => "Int32" } },
      { name: "name", type: { toString: () => "Utf8" } },
    ],
  };

  const createMockTable = (numRows: number, batches: unknown[] = [{}]) => ({
    numRows,
    numCols: 2,
    schema: mockSchema,
    batches,
  });

  return {
    tableFromIPC: vi.fn((buffer: Uint8Array) => {
      // Simulate different tables based on buffer content
      const marker = buffer[0] ?? 0;
      return createMockTable(marker * 10, [{ marker }]);
    }),
    tableToIPC: vi.fn(() => new Uint8Array([1, 2, 3, 4, 5])),
    Table: vi.fn().mockImplementation((schema, batches) => ({
      numRows: batches.reduce(
        (sum: number, b: { numRows?: number }) => sum + (b.numRows ?? 1),
        0,
      ),
      numCols: schema.fields.length,
      schema,
      batches,
    })),
  };
});

// Helper to create mock chunks
function createMockChunks(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    chunk_index: i,
    external_link: `https://example.com/chunk-${i}`,
    row_offset: i * 100,
    row_count: 100,
  }));
}

// Helper to create mock schema
function createMockSchema(): ResultSchema {
  return {
    columns: [
      { name: "id", type_name: "INT" },
      { name: "name", type_name: "STRING" },
    ],
  } as ResultSchema;
}

describe("ArrowStreamProcessor", () => {
  let processor: ArrowStreamProcessor;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    processor = new ArrowStreamProcessor({
      maxConcurrentDownloads: 3,
      timeout: 5000,
      retries: 3,
    });

    originalFetch = globalThis.fetch;

    // Default mock: successful fetch
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      // Extract chunk index from URL to create unique data
      const match = url.match(/chunk-(\d+)/);
      const chunkIndex = match ? parseInt(match[1], 10) : 0;

      return {
        ok: true,
        status: 200,
        statusText: "OK",
        arrayBuffer: async () => new Uint8Array([chunkIndex + 1]).buffer,
      };
    });

    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe("constructor", () => {
    test("should use default options when not provided", () => {
      const defaultProcessor = new ArrowStreamProcessor();
      // Verify it doesn't throw
      expect(defaultProcessor).toBeDefined();
    });

    test("should accept custom options", () => {
      const customProcessor = new ArrowStreamProcessor({
        maxConcurrentDownloads: 10,
        timeout: 60000,
        retries: 5,
      });
      expect(customProcessor).toBeDefined();
    });

    test("should use defaults for missing option properties", () => {
      const partialProcessor = new ArrowStreamProcessor({
        maxConcurrentDownloads: 2,
      } as any);
      expect(partialProcessor).toBeDefined();
    });
  });

  describe("processChunks", () => {
    test("should throw error when no chunks provided", async () => {
      await expect(
        processor.processChunks([], createMockSchema()),
      ).rejects.toThrow("No Arrow chunks provided");
    });

    test("should process single chunk successfully", async () => {
      const chunks = createMockChunks(1);
      const schema = createMockSchema();

      const result = await processor.processChunks(chunks, schema);

      expect(result).toHaveProperty("data");
      expect(result).toHaveProperty("schema", schema);
      expect(result).toHaveProperty("metadata");
      expect(result.metadata).toHaveProperty("rowCount");
      expect(result.metadata).toHaveProperty("columnCount");
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    test("should process multiple chunks successfully", async () => {
      const chunks = createMockChunks(5);
      const schema = createMockSchema();

      const result = await processor.processChunks(chunks, schema);

      expect(result.data).toBeInstanceOf(Uint8Array);
      expect(result.schema).toBe(schema);
      expect(globalThis.fetch).toHaveBeenCalledTimes(5);
    });

    test("should return serialized Arrow data", async () => {
      const chunks = createMockChunks(1);
      const schema = createMockSchema();

      const result = await processor.processChunks(chunks, schema);

      expect(result.data).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    });

    test("should pass abort signal to fetch", async () => {
      const chunks = createMockChunks(1);
      const schema = createMockSchema();
      const abortController = new AbortController();

      await processor.processChunks(chunks, schema, abortController.signal);

      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        }),
      );
    });
  });

  describe("concurrent downloads", () => {
    test("should limit concurrent downloads with semaphore", async () => {
      const maxConcurrent = 2;
      const limitedProcessor = new ArrowStreamProcessor({
        maxConcurrentDownloads: maxConcurrent,
        timeout: 5000,
        retries: 1,
      });

      let currentConcurrent = 0;
      let maxObservedConcurrent = 0;

      globalThis.fetch = vi.fn().mockImplementation(async () => {
        currentConcurrent++;
        maxObservedConcurrent = Math.max(
          maxObservedConcurrent,
          currentConcurrent,
        );

        // Simulate network delay
        await new Promise((resolve) => setTimeout(resolve, 10));

        currentConcurrent--;

        return {
          ok: true,
          arrayBuffer: async () => new Uint8Array([1]).buffer,
        };
      });

      const chunks = createMockChunks(10);
      await limitedProcessor.processChunks(chunks, createMockSchema());

      expect(maxObservedConcurrent).toBeLessThanOrEqual(maxConcurrent);
      expect(globalThis.fetch).toHaveBeenCalledTimes(10);
    });
  });

  describe("retry logic", () => {
    test("should retry on fetch failure", async () => {
      let attempts = 0;
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error("Network error");
        }
        return {
          ok: true,
          arrayBuffer: async () => new Uint8Array([1]).buffer,
        };
      });

      const chunks = createMockChunks(1);
      const result = await processor.processChunks(chunks, createMockSchema());

      expect(attempts).toBe(3);
      expect(result.data).toBeDefined();
    });

    test("should throw after exhausting retries", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

      const chunks = createMockChunks(1);

      await expect(
        processor.processChunks(chunks, createMockSchema()),
      ).rejects.toThrow(/Failed to download chunk 0 after 3 attempts/);

      expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    });

    test("should retry on non-ok response", async () => {
      let attempts = 0;
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        attempts++;
        if (attempts < 2) {
          return {
            ok: false,
            status: 500,
            statusText: "Internal Server Error",
          };
        }
        return {
          ok: true,
          arrayBuffer: async () => new Uint8Array([1]).buffer,
        };
      });

      const chunks = createMockChunks(1);
      const result = await processor.processChunks(chunks, createMockSchema());

      expect(attempts).toBe(2);
      expect(result.data).toBeDefined();
    });

    test("should use exponential backoff between retries", async () => {
      vi.useFakeTimers();

      let attempts = 0;
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error("Network error");
        }
        return {
          ok: true,
          arrayBuffer: async () => new Uint8Array([1]).buffer,
        };
      });

      const chunks = createMockChunks(1);
      const promise = processor.processChunks(chunks, createMockSchema());

      // First attempt - immediate
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toBe(1);

      // First retry after 1000ms (2^0 * 1000)
      await vi.advanceTimersByTimeAsync(1000);
      expect(attempts).toBe(2);

      // Second retry after 2000ms (2^1 * 1000)
      await vi.advanceTimersByTimeAsync(2000);
      expect(attempts).toBe(3);

      await promise;
      vi.useRealTimers();
    });
  });

  describe("timeout handling", () => {
    test("should timeout slow requests", async () => {
      const shortTimeoutProcessor = new ArrowStreamProcessor({
        maxConcurrentDownloads: 1,
        timeout: 50,
        retries: 1,
      });

      globalThis.fetch = vi.fn().mockImplementation(
        (_url: string, options?: { signal?: AbortSignal }) =>
          new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
              resolve({
                ok: true,
                arrayBuffer: async () => new Uint8Array([1]).buffer,
              });
            }, 5000); // Much longer than timeout

            // Listen for abort (from timeout)
            options?.signal?.addEventListener("abort", () => {
              clearTimeout(timeout);
              reject(new DOMException("Aborted", "AbortError"));
            });
          }),
      );

      const chunks = createMockChunks(1);

      // The processor should timeout and reject
      await expect(
        shortTimeoutProcessor.processChunks(chunks, createMockSchema()),
      ).rejects.toThrow(/timed out|Failed to download/);
    });

    test("should clear timeout after successful fetch", async () => {
      const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

      const chunks = createMockChunks(1);
      await processor.processChunks(chunks, createMockSchema());

      expect(clearTimeoutSpy).toHaveBeenCalled();
      clearTimeoutSpy.mockRestore();
    });
  });

  describe("abort signal handling", () => {
    test("should abort immediately if signal already aborted", async () => {
      const abortController = new AbortController();
      abortController.abort();

      // Mock fetch to check if it receives an aborted signal
      globalThis.fetch = vi
        .fn()
        .mockImplementation(
          async (_url: string, options?: { signal?: AbortSignal }) => {
            // If signal is already aborted, throw
            if (options?.signal?.aborted) {
              throw new DOMException("Aborted", "AbortError");
            }
            return {
              ok: true,
              arrayBuffer: async () => new Uint8Array([1]).buffer,
            };
          },
        );

      const chunks = createMockChunks(1);

      await expect(
        processor.processChunks(
          chunks,
          createMockSchema(),
          abortController.signal,
        ),
      ).rejects.toThrow(/abort/i);
    });

    test("should abort in-flight requests when signal fires", async () => {
      const abortController = new AbortController();
      let fetchStarted = false;

      globalThis.fetch = vi
        .fn()
        .mockImplementation(
          async (_url: string, options?: { signal?: AbortSignal }) => {
            fetchStarted = true;

            // Simulate slow request that checks signal
            return new Promise((resolve, reject) => {
              const timeout = setTimeout(() => {
                resolve({
                  ok: true,
                  arrayBuffer: async () => new Uint8Array([1]).buffer,
                });
              }, 1000);

              options?.signal?.addEventListener("abort", () => {
                clearTimeout(timeout);
                reject(new DOMException("Aborted", "AbortError"));
              });
            });
          },
        );

      const chunks = createMockChunks(1);
      const promise = processor.processChunks(
        chunks,
        createMockSchema(),
        abortController.signal,
      );

      // Wait for fetch to start, then abort
      await vi.waitFor(() => expect(fetchStarted).toBe(true));
      abortController.abort();

      await expect(promise).rejects.toThrow(/abort/i);
    });
  });

  describe("schema validation and table concatenation", () => {
    test("should concatenate tables from multiple chunks", async () => {
      const { Table } = await import("apache-arrow");

      const chunks = createMockChunks(3);
      await processor.processChunks(chunks, createMockSchema());

      // Table constructor should be called with combined batches
      expect(Table).toHaveBeenCalled();
    });

    test("should handle single chunk without concatenation", async () => {
      const { Table, tableFromIPC } = await import("apache-arrow");

      const chunks = createMockChunks(1);
      await processor.processChunks(chunks, createMockSchema());

      // Should parse the single chunk
      expect(tableFromIPC).toHaveBeenCalledTimes(1);
      // Should NOT call Table constructor for single chunk
      expect(Table).not.toHaveBeenCalled();
    });
  });

  describe("missing external_link handling", () => {
    test("should continue on missing external_link", async () => {
      // Create chunk without external_link
      const chunks = [
        { chunk_index: 0, external_link: undefined },
        { chunk_index: 1, external_link: "https://example.com/chunk-1" },
      ] as any;

      // Should throw because all chunks fail (first has no link, retries exhausted)
      // But it should log error for the missing link
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});

      // This will fail because chunk 0 has no external_link
      await expect(
        processor.processChunks(chunks, createMockSchema()),
      ).rejects.toThrow();

      expect(consoleSpy).toHaveBeenCalledWith(
        "External link is required",
        expect.objectContaining({ chunk_index: 0 }),
      );

      consoleSpy.mockRestore();
    });
  });

  describe("error messages", () => {
    test("should include chunk index in error message", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

      const chunks = createMockChunks(1);

      await expect(
        processor.processChunks(chunks, createMockSchema()),
      ).rejects.toThrow(/chunk 0/);
    });

    test("should include HTTP status in error message for failed responses", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        statusText: "Forbidden",
      });

      const singleRetryProcessor = new ArrowStreamProcessor({
        maxConcurrentDownloads: 1,
        timeout: 5000,
        retries: 1,
      });

      const chunks = createMockChunks(1);

      await expect(
        singleRetryProcessor.processChunks(chunks, createMockSchema()),
      ).rejects.toThrow(/403 Forbidden/);
    });
  });
});

describe("Semaphore (via ArrowStreamProcessor)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("should properly queue and release permits", async () => {
    const processor = new ArrowStreamProcessor({
      maxConcurrentDownloads: 1,
      timeout: 5000,
      retries: 1,
    });

    const order: number[] = [];

    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      const match = url.match(/chunk-(\d+)/);
      const index = match ? parseInt(match[1], 10) : 0;
      order.push(index);

      // Simulate varying response times
      await new Promise((resolve) => setTimeout(resolve, 5));

      return {
        ok: true,
        arrayBuffer: async () => new Uint8Array([index + 1]).buffer,
      };
    });

    const chunks = [
      { chunk_index: 0, external_link: "https://example.com/chunk-0" },
      { chunk_index: 1, external_link: "https://example.com/chunk-1" },
      { chunk_index: 2, external_link: "https://example.com/chunk-2" },
    ];

    await processor.processChunks(chunks as any, { columns: [] });

    // With concurrency of 1, they should complete in order
    // (though Promise.all doesn't guarantee order, the semaphore does)
    expect(order).toHaveLength(3);
    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
  });
});
