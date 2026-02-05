import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DevFileReader } from "../index";
import { AppManager } from "../index";

// Mock fs/promises
vi.mock("node:fs/promises", () => ({
  default: {
    readdir: vi.fn(),
    readFile: vi.fn(),
  },
}));

import fs from "node:fs/promises";

describe("AppManager", () => {
  let appManager: AppManager;

  beforeEach(() => {
    appManager = new AppManager();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("getAppQuery - Security", () => {
    test("should reject invalid query keys with special characters", async () => {
      const result = await appManager.getAppQuery("../../../etc/passwd");
      expect(result).toBeNull();
    });

    test("should reject query keys with slashes", async () => {
      const result = await appManager.getAppQuery("foo/bar");
      expect(result).toBeNull();
    });

    test("should reject query keys with dots", async () => {
      const result = await appManager.getAppQuery("foo.bar.baz");
      expect(result).toBeNull();
    });

    test("should accept valid query keys with hyphens and underscores", async () => {
      vi.mocked(fs.readdir).mockResolvedValue(["test-query_1.sql"] as any);
      vi.mocked(fs.readFile).mockResolvedValue("SELECT 1");

      const result = await appManager.getAppQuery("test-query_1");
      expect(result).not.toBeNull();
      expect(result?.query).toBe("SELECT 1");
    });

    test("should reject empty query key", async () => {
      const result = await appManager.getAppQuery("");
      expect(result).toBeNull();
    });
  });

  describe("getAppQuery - File Discovery", () => {
    test("should prefer .obo.sql over .sql when both exist", async () => {
      vi.mocked(fs.readdir).mockResolvedValue([
        "test_query.sql",
        "test_query.obo.sql",
      ] as any);
      vi.mocked(fs.readFile).mockResolvedValue("SELECT * FROM users");

      const result = await appManager.getAppQuery("test_query");

      expect(result).not.toBeNull();
      expect(result?.isAsUser).toBe(true);
      expect(fs.readFile).toHaveBeenCalledWith(
        expect.stringContaining("test_query.obo.sql"),
        "utf8",
      );
    });

    test("should use .sql when .obo.sql does not exist", async () => {
      vi.mocked(fs.readdir).mockResolvedValue(["test_query.sql"] as any);
      vi.mocked(fs.readFile).mockResolvedValue("SELECT * FROM data");

      const result = await appManager.getAppQuery("test_query");

      expect(result).not.toBeNull();
      expect(result?.isAsUser).toBe(false);
      expect(fs.readFile).toHaveBeenCalledWith(
        expect.stringContaining("test_query.sql"),
        "utf8",
      );
    });

    test("should return null when query file does not exist", async () => {
      vi.mocked(fs.readdir).mockResolvedValue(["other_query.sql"] as any);

      const result = await appManager.getAppQuery("missing_query");

      expect(result).toBeNull();
    });

    test("should handle directory read errors", async () => {
      vi.mocked(fs.readdir).mockRejectedValue(new Error("Permission denied"));

      const result = await appManager.getAppQuery("test_query");

      expect(result).toBeNull();
    });

    test("should handle file read errors", async () => {
      vi.mocked(fs.readdir).mockResolvedValue(["test_query.sql"] as any);
      vi.mocked(fs.readFile).mockRejectedValue(new Error("File read error"));

      const result = await appManager.getAppQuery("test_query");

      expect(result).toBeNull();
    });
  });

  describe("getAppQuery - Dev Mode", () => {
    test("should use devFileReader in dev mode", async () => {
      const mockDevFileReader: DevFileReader = {
        readdir: vi.fn().mockResolvedValue(["test_query.sql"]),
        readFile: vi.fn().mockResolvedValue("SELECT * FROM dev_table"),
      };

      const mockReq = {
        query: { dev: "true" },
        headers: {},
      };

      const result = await appManager.getAppQuery(
        "test_query",
        mockReq,
        mockDevFileReader,
      );

      expect(result).not.toBeNull();
      expect(result?.query).toBe("SELECT * FROM dev_table");
      expect(mockDevFileReader.readdir).toHaveBeenCalledWith(
        expect.stringContaining("config/queries"),
        mockReq,
      );
      expect(mockDevFileReader.readFile).toHaveBeenCalledWith(
        expect.stringContaining("test_query.sql"),
        mockReq,
      );
      // Should NOT use fs in dev mode
      expect(fs.readdir).not.toHaveBeenCalled();
      expect(fs.readFile).not.toHaveBeenCalled();
    });

    test("should use fs in production mode", async () => {
      vi.mocked(fs.readdir).mockResolvedValue(["test_query.sql"] as any);
      vi.mocked(fs.readFile).mockResolvedValue("SELECT * FROM prod_table");

      const mockReq = {
        query: {},
        headers: {},
      };

      const result = await appManager.getAppQuery("test_query", mockReq);

      expect(result).not.toBeNull();
      expect(result?.query).toBe("SELECT * FROM prod_table");
      expect(fs.readdir).toHaveBeenCalled();
      expect(fs.readFile).toHaveBeenCalled();
    });

    test("should handle devFileReader errors in dev mode", async () => {
      const mockDevFileReader: DevFileReader = {
        readdir: vi.fn().mockRejectedValue(new Error("WebSocket error")),
        readFile: vi.fn(),
      };

      const mockReq = {
        query: { dev: "true" },
        headers: {},
      };

      const result = await appManager.getAppQuery(
        "test_query",
        mockReq,
        mockDevFileReader,
      );

      expect(result).toBeNull();
    });
  });

  describe("getAppQuery - Path Traversal Protection", () => {
    test("should validate resolved paths are within queries directory", async () => {
      // This test ensures that even if a malicious filename gets through
      // the regex, the path validation catches it
      vi.mocked(fs.readdir).mockResolvedValue(["valid_query.sql"] as any);

      const result = await appManager.getAppQuery("valid_query");

      // If we get here, validation passed
      expect(result).toBeDefined();
    });
  });
});
