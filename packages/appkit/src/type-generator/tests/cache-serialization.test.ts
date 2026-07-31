import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  default: {
    access: mocks.access,
    mkdir: mocks.mkdir,
    writeFile: mocks.writeFile,
  },
}));

// Mock getCommittedCacheDir to return a consistent test path.
// cache.ts imports it from the Node-only "shared/cli/commands/cache-paths"
// subpath (kept out of the client-safe "shared" root barrel), so the mock must
// target that exact specifier.
vi.mock("shared/cli/commands/cache-paths", () => ({
  getCommittedCacheDir: () => "/test/app/.appkit",
}));

const { saveCache, queryCacheFileExists } = await import("../cache");

describe("cache serialization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("saves cache with sorted top-level query keys", async () => {
    const cache = {
      version: "3",
      queries: {
        zeta: { hash: "hash-z", type: "type-z", retry: false },
        alpha: { hash: "hash-a", type: "type-a", retry: false },
        mid: { hash: "hash-m", type: "type-m", retry: false },
      },
    };

    mocks.mkdir.mockResolvedValue(undefined);
    mocks.writeFile.mockResolvedValue(undefined);

    await saveCache(cache);

    // Verify mkdir was called with the correct directory
    expect(mocks.mkdir).toHaveBeenCalledWith("/test/app/.appkit", {
      recursive: true,
    });

    // Capture the JSON string passed to writeFile
    const writeFileCall = mocks.writeFile.mock.calls[0];
    expect(writeFileCall).toBeDefined();
    const writtenJson = writeFileCall[1] as string;
    const parsed = JSON.parse(writtenJson);

    // Assert top-level query keys are sorted ascending
    const queryKeys = Object.keys(parsed.queries);
    expect(queryKeys).toEqual(["alpha", "mid", "zeta"]);

    // Assert each key's value is preserved
    expect(parsed.queries.alpha.type).toBe("type-a");
    expect(parsed.queries.mid.type).toBe("type-m");
    expect(parsed.queries.zeta.type).toBe("type-z");
  });

  test("saves cache with sorted top-level metric keys", async () => {
    const cache = {
      version: "3",
      queries: {
        queryA: { hash: "hash-qa", type: "type-qa", retry: false },
      },
      metrics: {
        zeta_metric: {
          hash: "hash-zm",
          schema: {
            key: "zeta_metric",
            source: "schema1",
            lane: "sp" as const,
            measures: [{ name: "meas1", type: "double", isMeasure: true }],
            dimensions: [{ name: "dim1", type: "string", isMeasure: false }],
          },
          retry: false,
        },
        alpha_metric: {
          hash: "hash-am",
          schema: {
            key: "alpha_metric",
            source: "schema2",
            lane: "obo" as const,
            measures: [{ name: "meas2", type: "int", isMeasure: true }],
            dimensions: [{ name: "dim2", type: "timestamp", isMeasure: false }],
          },
          retry: false,
        },
      },
    };

    mocks.mkdir.mockResolvedValue(undefined);
    mocks.writeFile.mockResolvedValue(undefined);

    await saveCache(cache);

    const writeFileCall = mocks.writeFile.mock.calls[0];
    const writtenJson = writeFileCall[1] as string;
    const parsed = JSON.parse(writtenJson);

    // Assert top-level metric keys are sorted ascending
    const metricKeys = Object.keys(parsed.metrics);
    expect(metricKeys).toEqual(["alpha_metric", "zeta_metric"]);

    // Assert each metric's values are preserved
    expect(parsed.metrics.alpha_metric.schema.key).toBe("alpha_metric");
    expect(parsed.metrics.zeta_metric.schema.key).toBe("zeta_metric");
  });

  test("preserves nested entry values (measures, dimensions, schema fields) in original order", async () => {
    const measureArray = [
      { name: "measure1", type: "double", isMeasure: true },
      { name: "measure2", type: "int", isMeasure: true },
    ];
    const dimensionArray = [
      { name: "dim1", type: "string", isMeasure: false },
      { name: "dim2", type: "timestamp", isMeasure: false },
    ];

    const cache = {
      version: "3",
      queries: {},
      metrics: {
        my_metric: {
          hash: "test-hash",
          schema: {
            key: "my_metric",
            source: "test_source",
            lane: "sp" as const,
            measures: measureArray,
            dimensions: dimensionArray,
            degraded: false,
          },
          retry: false,
        },
      },
    };

    mocks.mkdir.mockResolvedValue(undefined);
    mocks.writeFile.mockResolvedValue(undefined);

    await saveCache(cache);

    const writeFileCall = mocks.writeFile.mock.calls[0];
    const writtenJson = writeFileCall[1] as string;
    const parsed = JSON.parse(writtenJson);

    // Assert nested array order is preserved
    expect(parsed.metrics.my_metric.schema.measures).toEqual(measureArray);
    expect(parsed.metrics.my_metric.schema.dimensions).toEqual(dimensionArray);

    // Assert other schema fields are preserved
    expect(parsed.metrics.my_metric.schema.degraded).toBe(false);
  });

  test("queryCacheFileExists returns true when file exists", async () => {
    mocks.access.mockResolvedValue(undefined);

    const result = await queryCacheFileExists();

    expect(result).toBe(true);
    expect(mocks.access).toHaveBeenCalledWith(
      "/test/app/.appkit/types-cache.json",
    );
  });

  test("queryCacheFileExists returns false when file does not exist", async () => {
    const error = new Error("ENOENT");
    (error as NodeJS.ErrnoException).code = "ENOENT";
    mocks.access.mockRejectedValue(error);

    const result = await queryCacheFileExists();

    expect(result).toBe(false);
  });

  test("queryCacheFileExists returns false for any error", async () => {
    mocks.access.mockRejectedValue(new Error("Some other error"));

    const result = await queryCacheFileExists();

    expect(result).toBe(false);
  });
});
