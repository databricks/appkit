import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mockGenerateServingTypes = vi.fn<any>(async () => {});
const mockFindServerFile = vi.fn<any>((): string | null => null);
const mockExtractServingEndpoints = vi.fn<any>(
  (): Record<string, { env: string }> | null => null,
);

vi.mock("../generator", () => ({
  generateServingTypes: (...args: any[]) => mockGenerateServingTypes(...args),
}));

vi.mock("../server-file-extractor", () => ({
  findServerFile: (...args: any[]) => mockFindServerFile(...args),
  extractServingEndpoints: (...args: any[]) =>
    mockExtractServingEndpoints(...args),
}));

import { appKitServingTypesPlugin } from "../vite-plugin";

describe("appKitServingTypesPlugin", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    mockGenerateServingTypes.mockReset();
    mockFindServerFile.mockReset();
    mockExtractServingEndpoints.mockReset();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  describe("apply()", () => {
    test("returns true when explicit endpoints provided", () => {
      const plugin = appKitServingTypesPlugin({
        endpoints: { llm: { env: "LLM_ENDPOINT" } },
      });
      expect((plugin as any).apply()).toBe(true);
    });

    test("returns true when DATABRICKS_SERVING_ENDPOINT_NAME is set", () => {
      process.env.DATABRICKS_SERVING_ENDPOINT_NAME = "my-endpoint";
      const plugin = appKitServingTypesPlugin();
      expect((plugin as any).apply()).toBe(true);
    });

    test("returns true when server file found in cwd", () => {
      mockFindServerFile.mockReturnValueOnce("/app/server/index.ts");
      const plugin = appKitServingTypesPlugin();
      expect((plugin as any).apply()).toBe(true);
    });

    test("returns true when server file found in parent dir", () => {
      mockFindServerFile
        .mockReturnValueOnce(null) // cwd check
        .mockReturnValueOnce("/app/server/index.ts"); // parent check
      const plugin = appKitServingTypesPlugin();
      expect((plugin as any).apply()).toBe(true);
    });

    test("returns false when nothing configured", () => {
      delete process.env.DATABRICKS_SERVING_ENDPOINT_NAME;
      mockFindServerFile.mockReturnValue(null);
      const plugin = appKitServingTypesPlugin();
      expect((plugin as any).apply()).toBe(false);
    });
  });

  describe("configResolved()", () => {
    test("resolves outFile relative to project root", async () => {
      const plugin = appKitServingTypesPlugin({
        endpoints: { llm: { env: "LLM" } },
      });
      (plugin as any).configResolved({ root: "/app/client" });
      await (plugin as any).buildStart();

      expect(mockGenerateServingTypes).toHaveBeenCalledWith(
        expect.objectContaining({
          outFile: expect.stringContaining(
            "/app/shared/appkit-types/serving.d.ts",
          ),
        }),
      );
    });

    test("uses custom outFile when provided", async () => {
      const plugin = appKitServingTypesPlugin({
        outFile: "types/serving.d.ts",
        endpoints: { llm: { env: "LLM" } },
      });
      (plugin as any).configResolved({ root: "/app/client" });
      await (plugin as any).buildStart();

      expect(mockGenerateServingTypes).toHaveBeenCalledWith(
        expect.objectContaining({
          outFile: expect.stringContaining("types/serving.d.ts"),
        }),
      );
    });
  });

  describe("buildStart()", () => {
    test("calls generateServingTypes with explicit endpoints", async () => {
      const endpoints = { llm: { env: "LLM_ENDPOINT" } };
      const plugin = appKitServingTypesPlugin({ endpoints });
      (plugin as any).configResolved({ root: "/app/client" });

      await (plugin as any).buildStart();

      expect(mockGenerateServingTypes).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoints,
          noCache: false,
        }),
      );
    });

    test("extracts endpoints from server file when not explicit", async () => {
      const extracted = { llm: { env: "LLM_EP" } };
      mockFindServerFile.mockReturnValue("/app/server/index.ts");
      mockExtractServingEndpoints.mockReturnValue(extracted);

      const plugin = appKitServingTypesPlugin();
      (plugin as any).configResolved({ root: "/app/client" });
      await (plugin as any).buildStart();

      expect(mockGenerateServingTypes).toHaveBeenCalledWith(
        expect.objectContaining({ endpoints: extracted }),
      );
    });

    test("passes undefined endpoints when no server file found", async () => {
      mockFindServerFile.mockReturnValue(null);

      const plugin = appKitServingTypesPlugin();
      (plugin as any).configResolved({ root: "/app/client" });
      await (plugin as any).buildStart();

      expect(mockGenerateServingTypes).toHaveBeenCalledWith(
        expect.objectContaining({ endpoints: undefined }),
      );
    });

    test("passes undefined when AST extraction returns null", async () => {
      mockFindServerFile.mockReturnValue("/app/server/index.ts");
      mockExtractServingEndpoints.mockReturnValue(null);

      const plugin = appKitServingTypesPlugin();
      (plugin as any).configResolved({ root: "/app/client" });
      await (plugin as any).buildStart();

      expect(mockGenerateServingTypes).toHaveBeenCalledWith(
        expect.objectContaining({ endpoints: undefined }),
      );
    });

    test("swallows errors in dev mode", async () => {
      process.env.NODE_ENV = "development";
      mockGenerateServingTypes.mockRejectedValue(new Error("fetch failed"));

      const plugin = appKitServingTypesPlugin({
        endpoints: { llm: { env: "LLM" } },
      });
      (plugin as any).configResolved({ root: "/app/client" });

      // Should not throw
      await expect((plugin as any).buildStart()).resolves.toBeUndefined();
    });

    test("rethrows errors in production mode", async () => {
      process.env.NODE_ENV = "production";
      mockGenerateServingTypes.mockRejectedValue(new Error("fetch failed"));

      const plugin = appKitServingTypesPlugin({
        endpoints: { llm: { env: "LLM" } },
      });
      (plugin as any).configResolved({ root: "/app/client" });

      await expect((plugin as any).buildStart()).rejects.toThrow(
        "fetch failed",
      );
    });
  });
});
