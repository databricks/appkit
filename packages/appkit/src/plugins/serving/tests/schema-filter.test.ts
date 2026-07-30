import { describe, expect, test, vi } from "vitest";
import { filterRequestBody, loadEndpointSchemas } from "../schema-filter";

vi.mock("node:fs/promises", () => ({
  default: {
    readFile: vi.fn(),
  },
}));

describe("schema-filter", () => {
  describe("filterRequestBody", () => {
    test("strips unknown keys when allowlist exists", () => {
      const allowlists = new Map([
        ["default", new Set(["messages", "temperature"])],
      ]);

      const result = filterRequestBody(
        { messages: [], temperature: 0.7, unknown_param: true },
        allowlists,
        "default",
      );

      expect(result).toEqual({ messages: [], temperature: 0.7 });
    });

    test("preserves all keys when no allowlist for alias", () => {
      const allowlists = new Map<string, Set<string>>();

      const body = { messages: [], custom: "value" };
      const result = filterRequestBody(body, allowlists, "default");

      expect(result).toBe(body); // Same reference, no filtering
    });

    test("returns empty object when all keys are unknown", () => {
      const allowlists = new Map([["default", new Set(["messages"])]]);

      const result = filterRequestBody(
        { bad1: 1, bad2: 2 },
        allowlists,
        "default",
      );

      expect(result).toEqual({});
    });

    test("returns full body when all keys are allowed", () => {
      const allowlists = new Map([["default", new Set(["a", "b", "c"])]]);

      const result = filterRequestBody(
        { a: 1, b: 2, c: 3 },
        allowlists,
        "default",
      );

      expect(result).toEqual({ a: 1, b: 2, c: 3 });
    });

    test("throws in reject mode when unknown keys are present", () => {
      const allowlists = new Map([["default", new Set(["messages"])]]);

      expect(() =>
        filterRequestBody(
          { messages: [], unknown_param: true },
          allowlists,
          "default",
          "reject",
        ),
      ).toThrow("Unknown request parameters: unknown_param");
    });

    test("does not throw in reject mode when all keys are allowed", () => {
      const allowlists = new Map([
        ["default", new Set(["messages", "temperature"])],
      ]);

      const result = filterRequestBody(
        { messages: [], temperature: 0.7 },
        allowlists,
        "default",
        "reject",
      );

      expect(result).toEqual({ messages: [], temperature: 0.7 });
    });

    test("strips in default mode (strip)", () => {
      const allowlists = new Map([["default", new Set(["messages"])]]);

      const result = filterRequestBody(
        { messages: [], extra: true },
        allowlists,
        "default",
        "strip",
      );

      expect(result).toEqual({ messages: [] });
    });
  });

  describe("loadEndpointSchemas", () => {
    test("returns empty map when cache file does not exist", async () => {
      const fs = (await import("node:fs/promises")).default;
      vi.mocked(fs.readFile).mockRejectedValue(
        Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
      );

      const result = await loadEndpointSchemas("/nonexistent/path");
      expect(result.size).toBe(0);
    });

    test("derives the allowlist from the request object's top-level keys", async () => {
      const fs = (await import("node:fs/promises")).default;
      // A committed serving.d.ts: the `request` type's top-level keys are the
      // allowlist for the alias.
      vi.mocked(fs.readFile).mockResolvedValue(`import "@databricks/appkit";
declare module "@databricks/appkit" {
  interface ServingEndpointRegistry {
    default: {
      request: {
        messages: Array<{ role: string; content: string }>;
        temperature: number;
        max_tokens: number;
      };
      response: { model: string };
      chunk: unknown;
    };
  }
}
`);

      const result = await loadEndpointSchemas("/some/path/serving.d.ts");
      expect(result.size).toBe(1);
      const keys = result.get("default");
      expect(keys).toBeDefined();
      expect(keys?.has("messages")).toBe(true);
      expect(keys?.has("temperature")).toBe(true);
      expect(keys?.has("max_tokens")).toBe(true);
      // Nested keys (e.g. `role`, `content`) are NOT part of the top-level allowlist.
      expect(keys?.has("role")).toBe(false);
    });

    test("a generic Record request yields no allowlist (passthrough mode)", async () => {
      const fs = (await import("node:fs/promises")).default;
      vi.mocked(fs.readFile).mockResolvedValue(`import "@databricks/appkit";
declare module "@databricks/appkit" {
  interface ServingEndpointRegistry {
    default: {
      request: Record<string, unknown>;
      response: unknown;
      chunk: unknown;
    };
  }
}
`);

      const result = await loadEndpointSchemas("/some/path/serving.d.ts");
      // Record<string, unknown> has no top-level keys → passthrough (no allowlist).
      expect(result.size).toBe(0);
    });
  });
});
