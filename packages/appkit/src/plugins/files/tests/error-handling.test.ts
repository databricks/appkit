import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { AuthenticationError } from "../../../errors";
import {
  createApiError,
  createMockWorkspaceClient,
  useTestCache,
} from "../../../testing";
import { withEnv } from "../../../testing";
import { FilesPlugin } from "../plugin";
import {
  getRouteHandler,
  mockRes,
  setupTestEnv,
  teardownTestEnv,
  VOLUMES_CONFIG,
} from "./_test-helpers";

// Boots AppKit's real in-memory cache (no cache-module mock needed).
useTestCache();

describe("FilesPlugin error handling", () => {
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

  describe("_handleApiError", () => {
    test("AuthenticationError returns generic 401 (raw message stays server-side)", async () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const res = mockRes();

      (plugin as any)._handleApiError(
        res,
        new AuthenticationError("Missing token"),
        "fallback msg",
      );

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({
        error: "Unauthorized",
        plugin: "files",
      });
    });

    test("ApiError with 4xx returns standard status text (raw message stays server-side)", () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const res = mockRes();

      (plugin as any)._handleApiError(
        res,
        createApiError({
          statusCode: 403,
          message: "Forbidden",
          errorCode: "ERROR",
        }),
        "fallback msg",
      );

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        error: "Forbidden",
        statusCode: 403,
        plugin: "files",
      });
    });

    test("ApiError with 404 returns standard status text", () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const res = mockRes();

      (plugin as any)._handleApiError(
        res,
        createApiError({
          statusCode: 404,
          message: "Not found",
          errorCode: "ERROR",
        }),
        "fallback msg",
      );

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({
        error: "Not Found",
        statusCode: 404,
        plugin: "files",
      });
    });

    test("ApiError with 409 Conflict returns standard status text", () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const res = mockRes();

      (plugin as any)._handleApiError(
        res,
        createApiError({
          statusCode: 409,
          message: "Conflict",
          errorCode: "ERROR",
        }),
        "fallback msg",
      );

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith({
        error: "Conflict",
        statusCode: 409,
        plugin: "files",
      });
    });

    test("ApiError with 5xx returns 500 with fallback message", () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const res = mockRes();

      (plugin as any)._handleApiError(
        res,
        createApiError({
          statusCode: 502,
          message: "Bad Gateway",
          errorCode: "ERROR",
        }),
        "Operation failed",
      );

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: "Operation failed",
        plugin: "files",
      });
    });

    test("ApiError with statusCode 500 returns 500 with fallback", () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const res = mockRes();

      (plugin as any)._handleApiError(
        res,
        createApiError({
          statusCode: 500,
          message: "Internal error",
          errorCode: "ERROR",
        }),
        "Fallback",
      );

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: "Fallback",
        plugin: "files",
      });
    });

    test("non-ApiError falls back to 500 with fallback message", () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const res = mockRes();

      (plugin as any)._handleApiError(res, new Error("unknown"), "Fallback");

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: "Fallback",
        plugin: "files",
      });
    });

    test("non-ApiError exception returns 500 with fallback message", async () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const res = mockRes();

      (plugin as any)._handleApiError(
        res,
        new TypeError("Cannot read properties of undefined"),
        "Internal Server Error",
      );

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: "Internal Server Error",
        plugin: "files",
      });
    });

    test("AuthenticationError via route returns generic 401 on OBO volume without token", async () => {
      await withEnv(
        {
          DATABRICKS_VOLUME_OBO: "/Volumes/catalog/schema/obo",
          NODE_ENV: "production",
        },
        async () => {
          const plugin = new FilesPlugin({
            volumes: {
              obo: { auth: "on-behalf-of-user", policy: () => true },
            },
          });
          const handler = getRouteHandler(plugin, "get", "/list");
          const res = mockRes();

          await handler(
            {
              params: { volumeKey: "obo" },
              query: {},
              headers: {},
              header: () => undefined,
            },
            res,
          );

          expect(res.status).toHaveBeenCalledWith(401);
          expect(res.json).toHaveBeenCalledWith({
            error: "Unauthorized",
            plugin: "files",
          });
        },
      );
    });
  });

  describe("_sendStatusError", () => {
    test("sends standard HTTP status text for known codes", () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const res = mockRes();

      (plugin as any)._sendStatusError(res, 404);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({
        error: "Not Found",
        plugin: "files",
      });
    });

    test("sends 'Unknown Error' for non-standard status codes", () => {
      const plugin = new FilesPlugin(VOLUMES_CONFIG);
      const res = mockRes();

      (plugin as any)._sendStatusError(res, 999);

      expect(res.status).toHaveBeenCalledWith(999);
      expect(res.json).toHaveBeenCalledWith({
        error: "Unknown Error",
        plugin: "files",
      });
    });
  });
});
