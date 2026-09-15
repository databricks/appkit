import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createMockWorkspaceClient, useTestCache } from "../../../testing";
import { withEnv } from "../../../testing";
import { FilesPlugin } from "../plugin";
import { setupTestEnv, teardownTestEnv, VOLUMES_CONFIG } from "./_test-helpers";

// Boots AppKit's real in-memory cache (no cache-module mock needed).
useTestCache();

describe("FilesPlugin volume config surface", () => {
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
      withEnv(
        { DATABRICKS_VOLUME_DATA: "/Volumes/catalog/schema/data" },
        () => {
          const volumes = FilesPlugin.discoverVolumes({});
          expect(volumes.data).toEqual({});
        },
      );
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
      withEnv(
        { DATABRICKS_VOLUME_SPECIAL: "/Volumes/catalog/schema/special" },
        () => {
          const volumes = FilesPlugin.discoverVolumes({
            volumes: {
              special: { maxUploadSize: 500 },
            },
          });

          // Explicit wins; should not be overwritten with {}
          expect(volumes.special).toEqual({ maxUploadSize: 500 });
        },
      );
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
