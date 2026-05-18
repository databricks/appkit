import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FilesPlugin } from "../plugin";
import { setupTestEnv, teardownTestEnv, VOLUMES_CONFIG } from "./_test-helpers";

const { mockClient, MockApiError, mockCacheInstance } = vi.hoisted(() => {
  const mockFilesApi = {
    listDirectoryContents: vi.fn(),
    download: vi.fn(),
    getMetadata: vi.fn(),
    upload: vi.fn(),
    createDirectory: vi.fn(),
    delete: vi.fn(),
  };
  const mockClient = {
    files: mockFilesApi,
    config: {
      host: "https://test.databricks.com",
      authenticate: vi.fn(),
    },
  };
  class MockApiError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number) {
      super(message);
      this.name = "ApiError";
      this.statusCode = statusCode;
    }
  }
  const mockCacheInstance = {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    getOrExecute: vi.fn(async (_key: unknown[], fn: () => Promise<unknown>) =>
      fn(),
    ),
    generateKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  };
  return { mockClient, MockApiError, mockCacheInstance };
});

vi.mock("@databricks/sdk-experimental", () => ({
  WorkspaceClient: vi.fn(() => mockClient),
  ApiError: MockApiError,
}));

vi.mock("../../../context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../context")>();
  return {
    ...actual,
    getWorkspaceClient: vi.fn(() => mockClient),
    isInUserContext: vi.fn(() => true),
  };
});

vi.mock("../../../cache", () => ({
  CacheManager: {
    getInstanceSync: vi.fn(() => mockCacheInstance),
  },
}));

describe("FilesPlugin volume config surface", () => {
  let serviceContextMock: Awaited<ReturnType<typeof setupTestEnv>>;

  beforeEach(async () => {
    serviceContextMock = await setupTestEnv();
  });

  afterEach(() => {
    teardownTestEnv(serviceContextMock);
  });

  describe("Volume discovery merging", () => {
    test("explicit config takes priority over env vars", () => {
      const volumes = FilesPlugin.discoverVolumes({
        volumes: {
          uploads: { maxUploadSize: 42 },
          custom: { maxUploadSize: 99 },
        },
      });

      // uploads: explicit config wins (maxUploadSize: 42), not {} from env
      expect(volumes.uploads).toEqual({ maxUploadSize: 42 });
      // exports: discovered from env with default empty config
      expect(volumes.exports).toEqual({});
      // custom: explicit only, no env var
      expect(volumes.custom).toEqual({ maxUploadSize: 99 });
    });

    test("discovered volumes get empty config objects", () => {
      process.env.DATABRICKS_VOLUME_DATA = "/Volumes/catalog/schema/data";

      try {
        const volumes = FilesPlugin.discoverVolumes({});
        expect(volumes.data).toEqual({});
      } finally {
        delete process.env.DATABRICKS_VOLUME_DATA;
      }
    });

    test("explicit volumes without env vars still appear", () => {
      delete process.env.DATABRICKS_VOLUME_UPLOADS;
      delete process.env.DATABRICKS_VOLUME_EXPORTS;

      const volumes = FilesPlugin.discoverVolumes({
        volumes: {
          private: { maxUploadSize: 10 },
        },
      });

      expect(Object.keys(volumes)).toEqual(["private"]);
      expect(volumes.private).toEqual({ maxUploadSize: 10 });
    });

    test("env var volume is not added when explicit config has the same key", () => {
      process.env.DATABRICKS_VOLUME_SPECIAL = "/Volumes/catalog/schema/special";

      try {
        const volumes = FilesPlugin.discoverVolumes({
          volumes: {
            special: { maxUploadSize: 500 },
          },
        });

        // Explicit wins; should not be overwritten with {}
        expect(volumes.special).toEqual({ maxUploadSize: 500 });
      } finally {
        delete process.env.DATABRICKS_VOLUME_SPECIAL;
      }
    });
  });

  describe("clientConfig", () => {
    test("returns configured volume keys", () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const config = plugin.clientConfig();

      expect(config).toEqual({ volumes: ["uploads", "exports"] });
    });

    test("returns empty volumes when none configured and no env vars", () => {
      delete process.env.DATABRICKS_VOLUME_UPLOADS;
      delete process.env.DATABRICKS_VOLUME_EXPORTS;

      const plugin = new FilesPlugin({ volumes: {} });
      const config = plugin.clientConfig();

      expect(config).toEqual({ volumes: [] });
    });
  });
});
