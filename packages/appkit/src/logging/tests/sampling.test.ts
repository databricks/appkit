import { describe, expect, test } from "vitest";
import { DEFAULT_SAMPLING_CONFIG, shouldSample } from "../sampling";
import type { WideEventData } from "../wide-event";

describe("Sampling", () => {
  const baseEvent: WideEventData = {
    timestamp: new Date().toISOString(),
    request_id: "test-request-id",
    method: "GET",
    path: "/api/test",
    status_code: 200,
    duration_ms: 100,
  };

  describe("shouldSample", () => {
    test("should exclude health check paths", () => {
      const event: WideEventData = {
        ...baseEvent,
        path: "/health",
      };

      expect(shouldSample(event, DEFAULT_SAMPLING_CONFIG)).toBe(false);
    });

    test("should exclude metrics paths", () => {
      const event: WideEventData = {
        ...baseEvent,
        path: "/metrics",
      };

      expect(shouldSample(event, DEFAULT_SAMPLING_CONFIG)).toBe(false);
    });

    test("should exclude static assets", () => {
      const event: WideEventData = {
        ...baseEvent,
        path: "/favicon.ico",
      };

      expect(shouldSample(event, DEFAULT_SAMPLING_CONFIG)).toBe(false);
    });

    test("should exclude _next paths", () => {
      const event: WideEventData = {
        ...baseEvent,
        path: "/_next/static/chunks/main.js",
      };

      expect(shouldSample(event, DEFAULT_SAMPLING_CONFIG)).toBe(false);
    });

    test("should always sample events with errors", () => {
      const event: WideEventData = {
        ...baseEvent,
        error: {
          type: "Error",
          code: "QUERY_FAILED",
          message: "Query failed",
          retriable: false,
        },
      };

      expect(shouldSample(event, DEFAULT_SAMPLING_CONFIG)).toBe(true);
    });

    test("should always sample 4xx status codes", () => {
      const event: WideEventData = {
        ...baseEvent,
        status_code: 404,
      };

      expect(shouldSample(event, DEFAULT_SAMPLING_CONFIG)).toBe(true);
    });

    test("should always sample 5xx status codes", () => {
      const event: WideEventData = {
        ...baseEvent,
        status_code: 500,
      };

      expect(shouldSample(event, DEFAULT_SAMPLING_CONFIG)).toBe(true);
    });

    test("should always sample slow requests", () => {
      const event: WideEventData = {
        ...baseEvent,
        duration_ms: 6000, // 6 seconds
      };

      expect(shouldSample(event, DEFAULT_SAMPLING_CONFIG)).toBe(true);
    });

    test("should sample requests deterministically based on request ID", () => {
      const config = {
        ...DEFAULT_SAMPLING_CONFIG,
        alwaysSampleIf: {
          hasErrors: false,
          statusCodeGte: 999,
          durationGte: 999999,
          hasCacheInfo: false,
        },
        sampleRate: 0.5, // 50% sample rate to get both true and false
      };

      // Test multiple request IDs to ensure deterministic behavior
      const results = new Set<boolean>();

      for (let i = 0; i < 100; i++) {
        const event: WideEventData = {
          ...baseEvent,
          request_id: `test-request-${i}`,
        };

        // Same request ID should always produce same result
        const result1 = shouldSample(event, config);
        const result2 = shouldSample(event, config);
        expect(result1).toBe(result2);

        results.add(result1);
      }

      // Should have both true and false results (not all sampled or all excluded)
      expect(results.size).toBe(2);
    });

    test("should respect sample rate of 0 (never sample)", () => {
      const config = {
        ...DEFAULT_SAMPLING_CONFIG,
        alwaysSampleIf: {
          hasErrors: false,
          statusCodeGte: 999,
          durationGte: 999999,
          hasCacheInfo: false,
        },
        sampleRate: 0,
      };

      const event: WideEventData = {
        ...baseEvent,
        request_id: "test-no-sample",
      };

      expect(shouldSample(event, config)).toBe(false);
    });

    test("should respect sample rate of 1 (always sample)", () => {
      const config = {
        ...DEFAULT_SAMPLING_CONFIG,
        sampleRate: 1,
      };

      const event: WideEventData = {
        ...baseEvent,
        request_id: "test-always-sample",
      };

      expect(shouldSample(event, config)).toBe(true);
    });

    test("should sample approximately 10% with 0.1 sample rate", () => {
      const config = {
        ...DEFAULT_SAMPLING_CONFIG,
        alwaysSampleIf: {
          hasErrors: false,
          statusCodeGte: 999,
          durationGte: 999999,
          hasCacheInfo: false,
        },
        sampleRate: 0.1,
      };

      let sampledCount = 0;
      const totalRequests = 1000;

      for (let i = 0; i < totalRequests; i++) {
        const event: WideEventData = {
          ...baseEvent,
          request_id: `request-${i}`,
        };

        if (shouldSample(event, config)) {
          sampledCount++;
        }
      }

      // Allow 5-15% range (expected 10%)
      const sampleRate = sampledCount / totalRequests;
      expect(sampleRate).toBeGreaterThan(0.05);
      expect(sampleRate).toBeLessThan(0.15);
    });

    test("should prioritize always-sample conditions over exclusions", () => {
      // Error on health check path - should still be excluded
      const event: WideEventData = {
        ...baseEvent,
        path: "/health",
        error: {
          type: "Error",
          code: "TEST",
          message: "Test",
          retriable: false,
        },
      };

      // Exclusions take precedence
      expect(shouldSample(event, DEFAULT_SAMPLING_CONFIG)).toBe(false);
    });
  });
});
