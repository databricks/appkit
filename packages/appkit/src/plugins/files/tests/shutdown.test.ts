import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createMockWorkspaceClient } from "../../../testing";
import { FilesPlugin } from "../plugin";
import { setupTestEnv, teardownTestEnv, VOLUMES_CONFIG } from "./_test-helpers";

const { mockCacheInstance } = await vi.hoisted(async () => {
  const { createCacheMock } = await import("../../../testing/cache-mock");
  return { mockCacheInstance: createCacheMock() };
});

vi.mock("../../../cache", () => ({
  CacheManager: {
    getInstanceSync: vi.fn(() => mockCacheInstance),
  },
}));

describe("FilesPlugin shutdown and trackWrite", () => {
  let serviceContextMock: Awaited<ReturnType<typeof setupTestEnv>>;

  let client: ReturnType<typeof createMockWorkspaceClient>;

  beforeEach(async () => {
    client = createMockWorkspaceClient({
      strict: true,
      responses: {
        "files.listDirectoryContents": undefined,
        "files.download": undefined,
        "files.getMetadata": undefined,
        "files.upload": undefined,
        "files.createDirectory": undefined,
        "files.delete": undefined,
      },
    });
    serviceContextMock = await setupTestEnv(client);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    teardownTestEnv(serviceContextMock);
  });

  test("shutdown waits for in-flight writes to complete", async () => {
    const plugin = new FilesPlugin(VOLUMES_CONFIG);

    (plugin as any).inflightWrites = 1;

    let settled = false;
    const shutdownPromise = plugin.shutdown().finally(() => {
      settled = true;
    });

    // After 500ms with inflightWrites > 0, shutdown must still be pending —
    // an immediate-return regression would settle here.
    await vi.advanceTimersByTimeAsync(500);
    expect(settled).toBe(false);

    // Simulate the write completing
    (plugin as any).inflightWrites = 0;

    await vi.advanceTimersByTimeAsync(500);
    await shutdownPromise;

    expect(settled).toBe(true);
    expect((plugin as any).inflightWrites).toBe(0);
  });

  test("shutdown times out after 10 seconds with pending writes", async () => {
    const plugin = new FilesPlugin(VOLUMES_CONFIG);
    const abortAllSpy = vi.spyOn((plugin as any).streamManager, "abortAll");

    (plugin as any).inflightWrites = 2;

    const shutdownPromise = plugin.shutdown();

    // Advance past the 10-second deadline
    await vi.advanceTimersByTimeAsync(11_000);
    await shutdownPromise;

    // Should still call abortAll even after timeout
    expect(abortAllSpy).toHaveBeenCalled();
    // inflightWrites remains > 0 since the writes never completed
    expect((plugin as any).inflightWrites).toBe(2);
  });

  test("shutdown completes immediately when no in-flight writes", async () => {
    const plugin = new FilesPlugin(VOLUMES_CONFIG);
    const abortAllSpy = vi.spyOn((plugin as any).streamManager, "abortAll");

    (plugin as any).inflightWrites = 0;

    const shutdownPromise = plugin.shutdown();
    await vi.advanceTimersByTimeAsync(0);
    await shutdownPromise;

    expect(abortAllSpy).toHaveBeenCalled();
  });

  test("trackWrite increments and decrements inflightWrites correctly", async () => {
    const plugin = new FilesPlugin(VOLUMES_CONFIG);
    expect((plugin as any).inflightWrites).toBe(0);

    let resolveInner!: (value: string) => void;
    const innerPromise = new Promise<string>((r) => {
      resolveInner = r;
    });

    const trackPromise = (plugin as any).trackWrite(() => innerPromise);

    expect((plugin as any).inflightWrites).toBe(1);

    resolveInner("done");
    const result = await trackPromise;

    expect(result).toBe("done");
    expect((plugin as any).inflightWrites).toBe(0);
  });

  test("trackWrite decrements inflightWrites even on rejection", async () => {
    const plugin = new FilesPlugin(VOLUMES_CONFIG);

    const trackPromise = (plugin as any).trackWrite(() =>
      Promise.reject(new Error("write failed")),
    );

    await expect(trackPromise).rejects.toThrow("write failed");
    expect((plugin as any).inflightWrites).toBe(0);
  });
});
