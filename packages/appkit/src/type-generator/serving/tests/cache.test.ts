import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  CACHE_VERSION,
  hashSchema,
  loadServingCache,
  type ServingCache,
  saveServingCache,
} from "../cache";

vi.mock("node:fs/promises");

describe("serving cache", () => {
  beforeEach(() => {
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("hashSchema", () => {
    test("returns consistent SHA256 hash", () => {
      const hash1 = hashSchema('{"openapi": "3.1.0"}');
      const hash2 = hashSchema('{"openapi": "3.1.0"}');
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA256 hex
    });

    test("different inputs produce different hashes", () => {
      const hash1 = hashSchema('{"a": 1}');
      const hash2 = hashSchema('{"a": 2}');
      expect(hash1).not.toBe(hash2);
    });
  });

  describe("loadServingCache", () => {
    test("returns empty cache when file does not exist", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(
        Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
      );

      const cache = await loadServingCache();
      expect(cache).toEqual({ version: CACHE_VERSION, endpoints: {} });
    });

    test("returns parsed cache when file exists with correct version", async () => {
      const cached: ServingCache = {
        version: CACHE_VERSION,
        endpoints: {
          llm: {
            hash: "abc",
            requestType: "{ messages: string[] }",
            responseType: "{ model: string }",
            chunkType: null,
            requestKeys: ["messages"],
          },
        },
      };
      vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(cached));

      const cache = await loadServingCache();
      expect(cache).toEqual(cached);
    });

    test("flushes cache when version mismatches", async () => {
      vi.mocked(fs.readFile).mockResolvedValue(
        JSON.stringify({ version: "0", endpoints: { old: {} } }),
      );

      const cache = await loadServingCache();
      expect(cache).toEqual({ version: CACHE_VERSION, endpoints: {} });
    });

    test("flushes cache when file is corrupted", async () => {
      vi.mocked(fs.readFile).mockResolvedValue("not json");

      const cache = await loadServingCache();
      expect(cache).toEqual({ version: CACHE_VERSION, endpoints: {} });
    });
  });

  describe("saveServingCache", () => {
    test("writes cache to file", async () => {
      vi.mocked(fs.writeFile).mockResolvedValue();

      const cache: ServingCache = {
        version: CACHE_VERSION,
        endpoints: {
          test: {
            hash: "xyz",
            requestType: "{}",
            responseType: "{}",
            chunkType: null,
            requestKeys: [],
          },
        },
      };

      await saveServingCache(cache);

      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining(".appkit-serving-types-cache.json"),
        JSON.stringify(cache, null, 2),
        "utf8",
      );
    });
  });
});
