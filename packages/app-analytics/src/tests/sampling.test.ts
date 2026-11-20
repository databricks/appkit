import { describe, expect, it } from "vitest";

import {
  DEFAULT_SAMPLE_RATE,
  isSessionSampled,
  normalizeSampleRate,
} from "../core/sampling";

describe("session sampling", () => {
  it("defaults absent and invalid rates to one", () => {
    expect(normalizeSampleRate(undefined)).toBe(DEFAULT_SAMPLE_RATE);
    expect(normalizeSampleRate(null)).toBe(DEFAULT_SAMPLE_RATE);
    expect(normalizeSampleRate("0.5")).toBe(DEFAULT_SAMPLE_RATE);
    expect(normalizeSampleRate(Number.NaN)).toBe(DEFAULT_SAMPLE_RATE);
    expect(normalizeSampleRate(Number.POSITIVE_INFINITY)).toBe(
      DEFAULT_SAMPLE_RATE,
    );
  });

  it("clamps finite rates to the inclusive zero-to-one range", () => {
    expect(normalizeSampleRate(-0.25)).toBe(0);
    expect(normalizeSampleRate(0.25)).toBe(0.25);
    expect(normalizeSampleRate(1.25)).toBe(1);
  });

  it("handles the zero and one boundaries without hashing", () => {
    expect(isSessionSampled("any-session", 0)).toBe(false);
    expect(isSessionSampled("any-session", 1)).toBe(true);
    expect(isSessionSampled("any-session", undefined)).toBe(true);
  });

  it("returns the same decision for repeated session IDs", () => {
    const decisions = Array.from({ length: 10 }, () =>
      isSessionSampled("stable-session", 0.5),
    );

    expect(new Set(decisions).size).toBe(1);
  });

  it("keeps deterministic fixtures stable", () => {
    expect(isSessionSampled("alpha", 0.3654)).toBe(false);
    expect(isSessionSampled("alpha", 0.3655)).toBe(true);
    expect(isSessionSampled("bravo", 0.633)).toBe(false);
    expect(isSessionSampled("bravo", 0.6331)).toBe(true);
    expect(isSessionSampled("app-analytics-fixture", 0.6499)).toBe(false);
    expect(isSessionSampled("app-analytics-fixture", 0.65)).toBe(true);
    expect(isSessionSampled("54724c2d-7fda-4c03-9528-2f9da1848fb8", 0.5)).toBe(
      false,
    );
  });
});
