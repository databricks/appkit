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

  test("returns false when APPKIT_TELEMETRY_DISABLED env var is true", () => {
    vi.stubEnv("APPKIT_TELEMETRY_DISABLED", "true");
    expect(isInternalTelemetryEnabled()).toBe(false);
  });

  test("returns true when APPKIT_TELEMETRY_DISABLED env var is not true", () => {
    vi.stubEnv("APPKIT_TELEMETRY_DISABLED", "false");
    expect(isInternalTelemetryEnabled()).toBe(true);
  });

  test("config option takes precedence over env var", () => {
    vi.stubEnv("APPKIT_TELEMETRY_DISABLED", "false");
    expect(isInternalTelemetryEnabled({ disableInternalTelemetry: true })).toBe(
      false,
    );
  });
});
