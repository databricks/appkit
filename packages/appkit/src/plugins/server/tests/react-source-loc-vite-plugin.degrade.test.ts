import { afterEach, describe, expect, it, vi } from "vitest";

// Force the lazy ast-grep loader to report the native binary as unavailable.
vi.mock("../../../internal/ast-grep", () => ({
  tryLoadAstGrep: vi.fn(() => null),
}));

import { reactSourceLocPlugin } from "../react-source-loc-vite-plugin";

interface TestableHooks {
  transform?: (code: string, id: string) => unknown;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reactSourceLocPlugin — ast-grep unavailable (degrade)", () => {
  // The "warn once" guard is module-level state, so a single test exercises
  // both behaviours: each call skips (returns undefined) but only the first
  // emits a warning.
  it("skips data-source annotation and warns exactly once across calls", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { transform } = reactSourceLocPlugin({
      projectRoot: "/app",
    }) as unknown as TestableHooks;

    expect(transform?.("const a = <div />;", "/app/src/A.tsx")).toBeUndefined();
    expect(
      transform?.("const b = <span />;", "/app/src/B.tsx"),
    ).toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0].join(" ")).toContain("native binary is");
  });
});
