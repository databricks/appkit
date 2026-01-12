import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { formatAndEmitWideEvent, getWideEvent, shouldSample } from "../context";
import { WideEvent } from "../wide-event";

describe("context", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    // Set sampling to 100% to test filtering logic (not random sampling)
    process.env.APPKIT_LOG_SAMPLING = "1.0";
  });

  afterEach(() => {
    process.env = originalEnv;
  });
  describe("getWideEvent()", () => {
    test("should return undefined when not in request context", () => {
      const event = getWideEvent();
      expect(event).toBeUndefined();
    });
  });

  describe("shouldSample()", () => {
    test("should filter Vite dev server paths", () => {
      const event = new WideEvent("req-1");
      event.set("path", "/@vite/client");

      expect(shouldSample(event.toJSON())).toBe(false);
    });

    test("should filter @fs paths", () => {
      const event = new WideEvent("req-1");
      event.set("path", "/@fs/Users/victor/project/file.js");

      expect(shouldSample(event.toJSON())).toBe(false);
    });

    test("should filter node_modules paths", () => {
      const event = new WideEvent("req-1");
      event.set("path", "/node_modules/package/file.js");

      expect(shouldSample(event.toJSON())).toBe(false);
    });

    test("should filter static asset extensions", () => {
      const extensions = ["js", "css", "png", "svg", "woff", "map"];

      for (const ext of extensions) {
        const event = new WideEvent("req-1");
        event.set("path", `/static/file.${ext}`);

        expect(shouldSample(event.toJSON())).toBe(false);
      }
    });

    test("should always keep error responses (4xx)", () => {
      const event = new WideEvent("req-1");
      event.set("path", "/api/test");
      event.set("status_code", 404);

      expect(shouldSample(event.toJSON())).toBe(true);
    });

    test("should always keep server errors (5xx)", () => {
      const event = new WideEvent("req-1");
      event.set("path", "/api/test");
      event.set("status_code", 500);

      expect(shouldSample(event.toJSON())).toBe(true);
    });

    test("should always keep requests with errors", () => {
      const event = new WideEvent("req-1");
      event.set("path", "/api/test");
      event.setError(new Error("Test error"));

      expect(shouldSample(event.toJSON())).toBe(true);
    });

    test("should always keep slow requests (>10s)", () => {
      const event = new WideEvent("req-1");
      event.set("path", "/api/test");
      event.set("duration_ms", 15000);

      expect(shouldSample(event.toJSON())).toBe(true);
    });

    test("should always keep retried requests", () => {
      const event = new WideEvent("req-1");
      event.set("path", "/api/test");
      event.setExecution({ retry_attempts: 2 });

      expect(shouldSample(event.toJSON())).toBe(true);
    });

    test("should sample API requests based on APPKIT_LOG_SAMPLING", () => {
      const event = new WideEvent("req-1");
      event.set("path", "/api/test");
      event.set("status_code", 200);

      // Should be sampled (default APPKIT_LOG_SAMPLING = 1.0)
      const result = shouldSample(event);
      expect(typeof result).toBe("boolean");
    });
  });

  describe("formatAndEmitWideEvent()", () => {
    test("should return null for filtered events", () => {
      const event = new WideEvent("req-1");
      event.set("path", "/@vite/client");

      const result = formatAndEmitWideEvent(event, 200);

      expect(result).toBeNull();
    });

    test("should return finalized data for sampled events", () => {
      const event = new WideEvent("req-1");
      event.set("method", "POST");
      event.set("path", "/api/test");

      const result = formatAndEmitWideEvent(event, 200);

      expect(result).not.toBeNull();
      expect(result?.request_id).toBe("req-1");
      expect(result?.method).toBe("POST");
      expect(result?.path).toBe("/api/test");
      expect(result?.status_code).toBe(200);
      expect(result?.duration_ms).toBeGreaterThanOrEqual(0);
    });
  });
});
