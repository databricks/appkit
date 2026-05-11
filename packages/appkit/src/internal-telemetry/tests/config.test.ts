import { afterEach, describe, expect, test, vi } from "vitest";
import { isInternalTelemetryEnabled } from "../config";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isInternalTelemetryEnabled", () => {
  test("returns true by default", () => {
    expect(isInternalTelemetryEnabled()).toBe(true);
  });

  test("returns false when disableInternalTelemetry is true", () => {
    expect(isInternalTelemetryEnabled({ disableInternalTelemetry: true })).toBe(
      false,
    );
  });

  test("returns true when disableInternalTelemetry is false", () => {
    expect(
      isInternalTelemetryEnabled({ disableInternalTelemetry: false }),
    ).toBe(true);
  });

  test("returns false when DISABLE_APPKIT_INTERNAL_TELEMETRY env var is true", () => {
    vi.stubEnv("DISABLE_APPKIT_INTERNAL_TELEMETRY", "true");
    expect(isInternalTelemetryEnabled()).toBe(false);
  });

  test("returns true when DISABLE_APPKIT_INTERNAL_TELEMETRY env var is not true", () => {
    vi.stubEnv("DISABLE_APPKIT_INTERNAL_TELEMETRY", "false");
    expect(isInternalTelemetryEnabled()).toBe(true);
  });

  test("config option takes precedence over env var", () => {
    vi.stubEnv("DISABLE_APPKIT_INTERNAL_TELEMETRY", "false");
    expect(isInternalTelemetryEnabled({ disableInternalTelemetry: true })).toBe(
      false,
    );
  });

  test("returns false when DO_NOT_TRACK env var is 1", () => {
    vi.stubEnv("DO_NOT_TRACK", "1");
    expect(isInternalTelemetryEnabled()).toBe(false);
  });

  test("returns true when DO_NOT_TRACK env var is 0", () => {
    vi.stubEnv("DO_NOT_TRACK", "0");
    expect(isInternalTelemetryEnabled()).toBe(true);
  });
});
