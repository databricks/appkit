import { describe, expect, it, vi } from "vitest";
import { createHooks, noopHooks } from "@/observability";

describe("noopHooks", () => {
  describe("withSpan", () => {
    it("should execute callback and return result", () => {
      const result = noopHooks.withSpan("test", {}, () => 42);
      expect(result).toBe(42);
    });

    it("should handle async callbacks", async () => {
      const result = await noopHooks.withSpan("test", {}, async () => "async");
      expect(result).toBe("async");
    });

    it("should propagate errors", () => {
      expect(() =>
        noopHooks.withSpan("test", {}, () => {
          throw new Error("test");
        }),
      ).toThrow("test");
    });
  });

  describe("createHooks", () => {
    it("should override specific hooks while keeping noop defaults", () => {
      const counter = vi.fn();
      const hooks = createHooks({
        incrementCounter: counter,
      });
      hooks.incrementCounter("test", 1);
      expect(counter).toHaveBeenCalledWith("test", 1);
      expect(hooks.withSpan("test", {}, () => 42)).toBe(42);
    });
  });
});
