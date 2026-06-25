import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  CHART_COLOR_VARS_CATEGORICAL,
  CHART_COLOR_VARS_DIVERGING,
  CHART_COLOR_VARS_SEQUENTIAL,
  CHART_UI_VARS,
  FALLBACK_COLORS_CATEGORICAL,
  FALLBACK_COLORS_DIVERGING,
  FALLBACK_COLORS_SEQUENTIAL,
  FALLBACK_UI_TOKENS,
} from "../constants";
import {
  resetThemeCache,
  useAllThemeColors,
  useChartUITokens,
  useThemeColors,
} from "../theme";
import type { ChartColorPalette } from "../types";

// Create a mock matchMedia function that returns a proper MediaQueryList mock
function createMockMatchMedia() {
  return (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  });
}

describe("useThemeColors", () => {
  // Store original getComputedStyle
  const originalGetComputedStyle = window.getComputedStyle;
  const originalMatchMedia = window.matchMedia;

  beforeEach(() => {
    // Reset the module-level cache before each test
    resetThemeCache();

    // Mock matchMedia
    window.matchMedia = createMockMatchMedia() as typeof window.matchMedia;

    // Reset to empty CSS variables by default
    vi.spyOn(window, "getComputedStyle").mockImplementation(
      () =>
        ({
          getPropertyValue: () => "",
        }) as unknown as CSSStyleDeclaration,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.getComputedStyle = originalGetComputedStyle;
    window.matchMedia = originalMatchMedia;
  });

  describe("fallback behavior", () => {
    test("returns categorical fallback colors when CSS vars unavailable", () => {
      const { result } = renderHook(() => useThemeColors("categorical"));

      expect(result.current).toEqual(FALLBACK_COLORS_CATEGORICAL);
    });

    test("returns sequential fallback colors when CSS vars unavailable", () => {
      const { result } = renderHook(() => useThemeColors("sequential"));

      expect(result.current).toEqual(FALLBACK_COLORS_SEQUENTIAL);
    });

    test("returns diverging fallback colors when CSS vars unavailable", () => {
      const { result } = renderHook(() => useThemeColors("diverging"));

      expect(result.current).toEqual(FALLBACK_COLORS_DIVERGING);
    });

    test("defaults to categorical when no palette specified", () => {
      const { result } = renderHook(() => useThemeColors());

      expect(result.current).toEqual(FALLBACK_COLORS_CATEGORICAL);
    });
  });

  describe("CSS variable resolution", () => {
    test("reads colors from CSS variables", () => {
      const mockColors = ["#ff0000", "#00ff00", "#0000ff"];

      vi.spyOn(window, "getComputedStyle").mockImplementation(() => {
        let callCount = 0;
        return {
          getPropertyValue: (prop: string) => {
            if (prop.startsWith("--chart-cat-")) {
              const color = mockColors[callCount] || "";
              callCount++;
              return color;
            }
            return "";
          },
        } as unknown as CSSStyleDeclaration;
      });

      const { result } = renderHook(() => useThemeColors("categorical"));

      expect(result.current).toEqual(mockColors);
    });

    test("filters out empty/invalid CSS variable values", () => {
      vi.spyOn(window, "getComputedStyle").mockImplementation(() => {
        const values: Record<string, string> = {
          "--chart-cat-1": "#ff0000",
          "--chart-cat-2": "", // empty
          "--chart-cat-3": "#0000ff",
          "--chart-cat-4": "   ", // whitespace only
          "--chart-cat-5": "#00ff00",
        };
        return {
          getPropertyValue: (prop: string) => values[prop] || "",
        } as unknown as CSSStyleDeclaration;
      });

      const { result } = renderHook(() => useThemeColors("categorical"));

      // Should only include non-empty values
      expect(result.current).toEqual(["#ff0000", "#0000ff", "#00ff00"]);
    });

    test("uses fallback when all CSS variables are empty", () => {
      vi.spyOn(window, "getComputedStyle").mockImplementation(
        () =>
          ({
            getPropertyValue: () => "",
          }) as unknown as CSSStyleDeclaration,
      );

      const { result } = renderHook(() => useThemeColors("categorical"));

      expect(result.current).toEqual(FALLBACK_COLORS_CATEGORICAL);
    });
  });

  describe("return value characteristics", () => {
    test("returns an array of strings", () => {
      const { result } = renderHook(() => useThemeColors());

      expect(Array.isArray(result.current)).toBe(true);
      result.current.forEach((color) => {
        expect(typeof color).toBe("string");
      });
    });

    test("returns at least 8 colors", () => {
      const { result } = renderHook(() => useThemeColors());

      expect(result.current.length).toBeGreaterThanOrEqual(8);
    });

    test("all fallback colors are valid CSS color values", () => {
      const { result } = renderHook(() => useThemeColors());

      result.current.forEach((color) => {
        // Check that it's a valid hsla or hex color
        expect(color).toMatch(/^(hsla?\(|rgba?\(|#)/);
      });
    });
  });

  describe("palette switching", () => {
    test("returns different colors for different palettes", () => {
      const { result: categorical } = renderHook(() =>
        useThemeColors("categorical"),
      );
      const { result: sequential } = renderHook(() =>
        useThemeColors("sequential"),
      );
      const { result: diverging } = renderHook(() =>
        useThemeColors("diverging"),
      );

      // Each palette should return different colors
      expect(categorical.current).not.toEqual(sequential.current);
      expect(sequential.current).not.toEqual(diverging.current);
      expect(categorical.current).not.toEqual(diverging.current);
    });

    test("updates colors when palette prop changes", () => {
      // Switching the palette argument at runtime must re-resolve immediately,
      // without waiting for a theme-change event.

      vi.spyOn(window, "getComputedStyle").mockImplementation(() => {
        return {
          getPropertyValue: (prop: string) => {
            if (prop === "--chart-cat-1") return "#cat1";
            if (prop === "--chart-cat-2") return "#cat2";
            if (prop === "--chart-seq-1") return "#seq1";
            if (prop === "--chart-seq-2") return "#seq2";
            return "";
          },
        } as unknown as CSSStyleDeclaration;
      });

      const { result, rerender } = renderHook(
        ({ palette }: { palette: ChartColorPalette }) =>
          useThemeColors(palette),
        { initialProps: { palette: "categorical" as ChartColorPalette } },
      );

      expect(result.current).toEqual(["#cat1", "#cat2"]);

      rerender({ palette: "sequential" as ChartColorPalette });

      // Colors reflect the new palette right away.
      expect(result.current).toEqual(["#seq1", "#seq2"]);
    });
  });

  describe("correct CSS variable names per palette", () => {
    test("reads --chart-cat-* variables for categorical palette", () => {
      const getPropertyValueSpy = vi.fn().mockReturnValue("");

      vi.spyOn(window, "getComputedStyle").mockImplementation(
        () =>
          ({
            getPropertyValue: getPropertyValueSpy,
          }) as unknown as CSSStyleDeclaration,
      );

      renderHook(() => useThemeColors("categorical"));

      // Should have called getPropertyValue with categorical CSS vars
      for (const varName of CHART_COLOR_VARS_CATEGORICAL) {
        expect(getPropertyValueSpy).toHaveBeenCalledWith(varName);
      }
    });

    test("reads --chart-seq-* variables for sequential palette", () => {
      const getPropertyValueSpy = vi.fn().mockReturnValue("");

      vi.spyOn(window, "getComputedStyle").mockImplementation(
        () =>
          ({
            getPropertyValue: getPropertyValueSpy,
          }) as unknown as CSSStyleDeclaration,
      );

      renderHook(() => useThemeColors("sequential"));

      // Should have called getPropertyValue with sequential CSS vars
      for (const varName of CHART_COLOR_VARS_SEQUENTIAL) {
        expect(getPropertyValueSpy).toHaveBeenCalledWith(varName);
      }
    });

    test("reads --chart-div-* variables for diverging palette", () => {
      const getPropertyValueSpy = vi.fn().mockReturnValue("");

      vi.spyOn(window, "getComputedStyle").mockImplementation(
        () =>
          ({
            getPropertyValue: getPropertyValueSpy,
          }) as unknown as CSSStyleDeclaration,
      );

      renderHook(() => useThemeColors("diverging"));

      // Should have called getPropertyValue with diverging CSS vars
      for (const varName of CHART_COLOR_VARS_DIVERGING) {
        expect(getPropertyValueSpy).toHaveBeenCalledWith(varName);
      }
    });
  });

  describe("theme change reactivity", () => {
    test("subscribes to matchMedia color scheme changes", () => {
      const addEventListenerSpy = vi.fn();
      const removeEventListenerSpy = vi.fn();

      window.matchMedia = vi.fn().mockImplementation((query) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: addEventListenerSpy,
        removeEventListener: removeEventListenerSpy,
        dispatchEvent: vi.fn(),
      }));

      const { unmount } = renderHook(() => useThemeColors());

      expect(window.matchMedia).toHaveBeenCalledWith(
        "(prefers-color-scheme: dark)",
      );
      expect(addEventListenerSpy).toHaveBeenCalledWith(
        "change",
        expect.any(Function),
      );

      unmount();

      expect(removeEventListenerSpy).toHaveBeenCalledWith(
        "change",
        expect.any(Function),
      );
    });

    test("subscribes to MutationObserver for theme attribute changes", () => {
      const observeSpy = vi.fn();
      const disconnectSpy = vi.fn();

      const MockMutationObserver = vi.fn().mockImplementation(() => ({
        observe: observeSpy,
        disconnect: disconnectSpy,
      }));

      window.MutationObserver = MockMutationObserver;

      const { unmount } = renderHook(() => useThemeColors());

      expect(MockMutationObserver).toHaveBeenCalledWith(expect.any(Function));
      expect(observeSpy).toHaveBeenCalledWith(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "data-theme", "data-mode"],
      });

      unmount();

      expect(disconnectSpy).toHaveBeenCalled();
    });

    test("updates colors when system color scheme changes", () => {
      let matchMediaCallback: () => void = () => {};

      window.matchMedia = vi.fn().mockImplementation((query) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: (_event: string, callback: () => void) => {
          matchMediaCallback = callback;
        },
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }));

      // Also mock MutationObserver since the effect uses it
      window.MutationObserver = vi.fn().mockImplementation(() => ({
        observe: vi.fn(),
        disconnect: vi.fn(),
      }));

      let callCount = 0;
      vi.spyOn(window, "getComputedStyle").mockImplementation(() => {
        return {
          getPropertyValue: (prop: string) => {
            if (prop === "--chart-cat-1") {
              // Return different color on subsequent calls
              return callCount++ === 0 ? "#initial" : "#updated";
            }
            return "";
          },
        } as unknown as CSSStyleDeclaration;
      });

      const { result } = renderHook(() => useThemeColors("categorical"));

      expect(result.current).toEqual(["#initial"]);

      // Simulate theme change
      act(() => {
        matchMediaCallback();
      });

      expect(result.current).toEqual(["#updated"]);
    });

    test("updates colors when theme attributes change via MutationObserver", () => {
      let mutationCallback: () => void = () => {};

      const MockMutationObserver = vi.fn().mockImplementation((callback) => {
        mutationCallback = callback;
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      });

      window.MutationObserver = MockMutationObserver;

      let callCount = 0;
      vi.spyOn(window, "getComputedStyle").mockImplementation(() => {
        return {
          getPropertyValue: (prop: string) => {
            if (prop === "--chart-cat-1") {
              return callCount++ === 0 ? "#light" : "#dark";
            }
            return "";
          },
        } as unknown as CSSStyleDeclaration;
      });

      const { result } = renderHook(() => useThemeColors("categorical"));

      expect(result.current).toEqual(["#light"]);

      // Simulate class attribute change (e.g., adding "dark" class)
      act(() => {
        mutationCallback();
      });

      expect(result.current).toEqual(["#dark"]);
    });
  });

  describe("effect cleanup", () => {
    test("removes all listeners on unmount", () => {
      const removeEventListenerSpy = vi.fn();
      const disconnectSpy = vi.fn();

      window.matchMedia = vi.fn().mockImplementation((query) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: removeEventListenerSpy,
        dispatchEvent: vi.fn(),
      }));

      window.MutationObserver = vi.fn().mockImplementation(() => ({
        observe: vi.fn(),
        disconnect: disconnectSpy,
      }));

      const { unmount } = renderHook(() => useThemeColors());

      unmount();

      expect(removeEventListenerSpy).toHaveBeenCalled();
      expect(disconnectSpy).toHaveBeenCalled();
    });

    test("does not churn listeners when palette changes", () => {
      const removeEventListenerSpy = vi.fn();
      const disconnectSpy = vi.fn();
      const addEventListenerSpy = vi.fn();
      const observeSpy = vi.fn();

      window.matchMedia = vi.fn().mockImplementation((query) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: addEventListenerSpy,
        removeEventListener: removeEventListenerSpy,
        dispatchEvent: vi.fn(),
      }));

      window.MutationObserver = vi.fn().mockImplementation(() => ({
        observe: observeSpy,
        disconnect: disconnectSpy,
      }));

      const { rerender, unmount } = renderHook(
        ({ palette }: { palette: ChartColorPalette }) =>
          useThemeColors(palette),
        { initialProps: { palette: "categorical" as ChartColorPalette } },
      );

      // Initial setup: one shared listener + observer.
      expect(addEventListenerSpy).toHaveBeenCalledTimes(1);
      expect(observeSpy).toHaveBeenCalledTimes(1);

      // Changing the palette swaps the hook's callback but must NOT re-install
      // the shared listeners — this is the per-render subscription churn the
      // shared subscriber removes.
      rerender({ palette: "sequential" as ChartColorPalette });

      expect(removeEventListenerSpy).not.toHaveBeenCalled();
      expect(disconnectSpy).not.toHaveBeenCalled();
      expect(addEventListenerSpy).toHaveBeenCalledTimes(1);
      expect(observeSpy).toHaveBeenCalledTimes(1);

      // Listeners are torn down only when the hook unmounts.
      unmount();

      expect(removeEventListenerSpy).toHaveBeenCalledTimes(1);
      expect(disconnectSpy).toHaveBeenCalledTimes(1);
    });
  });
});

describe("useAllThemeColors", () => {
  const originalGetComputedStyle = window.getComputedStyle;
  const originalMatchMedia = window.matchMedia;
  const originalMutationObserver = window.MutationObserver;

  beforeEach(() => {
    // Reset the module-level cache before each test
    resetThemeCache();

    // Mock matchMedia
    window.matchMedia = createMockMatchMedia() as typeof window.matchMedia;

    // Mock MutationObserver
    window.MutationObserver = vi.fn().mockImplementation(() => ({
      observe: vi.fn(),
      disconnect: vi.fn(),
    }));

    // Reset to empty CSS variables - will use fallbacks
    vi.spyOn(window, "getComputedStyle").mockImplementation(
      () =>
        ({
          getPropertyValue: () => "",
        }) as unknown as CSSStyleDeclaration,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.getComputedStyle = originalGetComputedStyle;
    window.matchMedia = originalMatchMedia;
    window.MutationObserver = originalMutationObserver;
  });

  test("returns all three color palettes", () => {
    const { result } = renderHook(() => useAllThemeColors());

    expect(result.current).toHaveProperty("categorical");
    expect(result.current).toHaveProperty("sequential");
    expect(result.current).toHaveProperty("diverging");
  });

  test("each palette has at least 8 colors", () => {
    const { result } = renderHook(() => useAllThemeColors());

    expect(result.current.categorical.length).toBeGreaterThanOrEqual(8);
    expect(result.current.sequential.length).toBeGreaterThanOrEqual(8);
    expect(result.current.diverging.length).toBeGreaterThanOrEqual(8);
  });

  test("returns fallback colors when CSS vars unavailable", () => {
    const { result } = renderHook(() => useAllThemeColors());

    expect(result.current.categorical).toEqual(FALLBACK_COLORS_CATEGORICAL);
    expect(result.current.sequential).toEqual(FALLBACK_COLORS_SEQUENTIAL);
    expect(result.current.diverging).toEqual(FALLBACK_COLORS_DIVERGING);
  });

  test("palettes are distinct from each other", () => {
    const { result } = renderHook(() => useAllThemeColors());

    expect(result.current.categorical).not.toEqual(result.current.sequential);
    expect(result.current.sequential).not.toEqual(result.current.diverging);
    expect(result.current.categorical).not.toEqual(result.current.diverging);
  });

  test("each palette contains only string values", () => {
    const { result } = renderHook(() => useAllThemeColors());

    for (const palette of Object.values(result.current)) {
      expect(Array.isArray(palette)).toBe(true);
      palette.forEach((color) => {
        expect(typeof color).toBe("string");
      });
    }
  });
});

describe("useChartUITokens", () => {
  const originalGetComputedStyle = window.getComputedStyle;
  const originalMatchMedia = window.matchMedia;
  const originalMutationObserver = window.MutationObserver;

  beforeEach(() => {
    resetThemeCache();
    window.matchMedia = createMockMatchMedia() as typeof window.matchMedia;
    window.MutationObserver = vi.fn().mockImplementation(() => ({
      observe: vi.fn(),
      disconnect: vi.fn(),
    }));
    // Default: empty CSS variables → fallbacks
    vi.spyOn(window, "getComputedStyle").mockImplementation(
      () =>
        ({
          getPropertyValue: () => "",
        }) as unknown as CSSStyleDeclaration,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.getComputedStyle = originalGetComputedStyle;
    window.matchMedia = originalMatchMedia;
    window.MutationObserver = originalMutationObserver;
  });

  test("returns fallback UI tokens when CSS vars unavailable", () => {
    const { result } = renderHook(() => useChartUITokens());

    expect(result.current).toEqual(FALLBACK_UI_TOKENS);
  });

  test("reads UI tokens from CSS variables by name", () => {
    const values: Record<string, string> = {
      [CHART_UI_VARS.axisLabel]: "rgb(10, 10, 10)",
      [CHART_UI_VARS.axisTitle]: "rgb(20, 20, 20)",
      [CHART_UI_VARS.grid]: "rgb(30, 30, 30)",
      [CHART_UI_VARS.tooltipBg]: "rgb(40, 40, 40)",
    };
    vi.spyOn(window, "getComputedStyle").mockImplementation(
      () =>
        ({
          getPropertyValue: (prop: string) => values[prop] || "",
        }) as unknown as CSSStyleDeclaration,
    );

    const { result } = renderHook(() => useChartUITokens());

    expect(result.current).toEqual({
      axisLabel: "rgb(10, 10, 10)",
      axisTitle: "rgb(20, 20, 20)",
      grid: "rgb(30, 30, 30)",
      tooltipBg: "rgb(40, 40, 40)",
    });
  });

  test("falls back per field when only some UI vars resolve", () => {
    // axisTitle intentionally missing — must fall back without shifting the
    // others (the failure mode of the old positional-array resolution).
    const values: Record<string, string> = {
      [CHART_UI_VARS.axisLabel]: "rgb(10, 10, 10)",
      [CHART_UI_VARS.grid]: "rgb(30, 30, 30)",
    };
    vi.spyOn(window, "getComputedStyle").mockImplementation(
      () =>
        ({
          getPropertyValue: (prop: string) => values[prop] || "",
        }) as unknown as CSSStyleDeclaration,
    );

    const { result } = renderHook(() => useChartUITokens());

    expect(result.current).toEqual({
      axisLabel: "rgb(10, 10, 10)",
      axisTitle: FALLBACK_UI_TOKENS.axisTitle,
      grid: "rgb(30, 30, 30)",
      tooltipBg: FALLBACK_UI_TOKENS.tooltipBg,
    });
  });

  test("reads each UI CSS variable by name", () => {
    const getPropertyValueSpy = vi.fn().mockReturnValue("");
    vi.spyOn(window, "getComputedStyle").mockImplementation(
      () =>
        ({
          getPropertyValue: getPropertyValueSpy,
        }) as unknown as CSSStyleDeclaration,
    );

    renderHook(() => useChartUITokens());

    for (const varName of Object.values(CHART_UI_VARS)) {
      expect(getPropertyValueSpy).toHaveBeenCalledWith(varName);
    }
  });

  // Listener wiring (subscribe/cleanup/ref-counting) is shared via
  // useThemeChangeEffect and covered by useThemeColors + the "shared
  // theme-change subscription" block; here we only assert token values re-resolve.
  describe("theme change reactivity", () => {
    test("updates tokens when system color scheme changes", () => {
      let matchMediaCallback: () => void = () => {};

      window.matchMedia = vi.fn().mockImplementation((query) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: (_event: string, callback: () => void) => {
          matchMediaCallback = callback;
        },
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }));
      window.MutationObserver = vi.fn().mockImplementation(() => ({
        observe: vi.fn(),
        disconnect: vi.fn(),
      }));

      let callCount = 0;
      vi.spyOn(window, "getComputedStyle").mockImplementation(() => {
        return {
          getPropertyValue: (prop: string) => {
            if (prop === CHART_UI_VARS.axisLabel) {
              return callCount++ === 0 ? "rgb(1, 1, 1)" : "rgb(2, 2, 2)";
            }
            return "";
          },
        } as unknown as CSSStyleDeclaration;
      });

      const { result } = renderHook(() => useChartUITokens());

      expect(result.current.axisLabel).toBe("rgb(1, 1, 1)");

      act(() => {
        matchMediaCallback();
      });

      expect(result.current.axisLabel).toBe("rgb(2, 2, 2)");
    });

    test("updates tokens when theme attributes change via MutationObserver", () => {
      let mutationCallback: () => void = () => {};

      window.MutationObserver = vi.fn().mockImplementation((callback) => {
        mutationCallback = callback;
        return {
          observe: vi.fn(),
          disconnect: vi.fn(),
        };
      });

      let callCount = 0;
      vi.spyOn(window, "getComputedStyle").mockImplementation(() => {
        return {
          getPropertyValue: (prop: string) => {
            if (prop === CHART_UI_VARS.axisLabel) {
              return callCount++ === 0 ? "rgb(10, 10, 10)" : "rgb(20, 20, 20)";
            }
            return "";
          },
        } as unknown as CSSStyleDeclaration;
      });

      const { result } = renderHook(() => useChartUITokens());

      expect(result.current.axisLabel).toBe("rgb(10, 10, 10)");

      act(() => {
        mutationCallback();
      });

      expect(result.current.axisLabel).toBe("rgb(20, 20, 20)");
    });
  });
});

describe("shared theme-change subscription", () => {
  const originalGetComputedStyle = window.getComputedStyle;
  const originalMatchMedia = window.matchMedia;
  const originalMutationObserver = window.MutationObserver;

  beforeEach(() => {
    resetThemeCache();
    vi.spyOn(window, "getComputedStyle").mockImplementation(
      () =>
        ({
          getPropertyValue: () => "",
        }) as unknown as CSSStyleDeclaration,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.getComputedStyle = originalGetComputedStyle;
    window.matchMedia = originalMatchMedia;
    window.MutationObserver = originalMutationObserver;
  });

  test("installs one shared listener for many hooks and releases it only after the last unmounts", () => {
    const addEventListenerSpy = vi.fn();
    const removeEventListenerSpy = vi.fn();
    window.matchMedia = vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: addEventListenerSpy,
      removeEventListener: removeEventListenerSpy,
      dispatchEvent: vi.fn(),
    }));

    const observeSpy = vi.fn();
    const disconnectSpy = vi.fn();
    window.MutationObserver = vi.fn().mockImplementation(() => ({
      observe: observeSpy,
      disconnect: disconnectSpy,
    }));

    // Three independent hook instances — what a dashboard with several charts
    // looks like. The old per-hook design installed three listeners + observers.
    const a = renderHook(() => useThemeColors("categorical"));
    const b = renderHook(() => useChartUITokens());
    const c = renderHook(() => useThemeColors("sequential"));

    expect(window.matchMedia).toHaveBeenCalledTimes(1);
    expect(addEventListenerSpy).toHaveBeenCalledTimes(1);
    expect(observeSpy).toHaveBeenCalledTimes(1);

    // Tearing down all but the last keeps the shared listener alive.
    a.unmount();
    b.unmount();
    expect(removeEventListenerSpy).not.toHaveBeenCalled();
    expect(disconnectSpy).not.toHaveBeenCalled();

    // The final unmount releases the shared listener exactly once.
    c.unmount();
    expect(removeEventListenerSpy).toHaveBeenCalledTimes(1);
    expect(disconnectSpy).toHaveBeenCalledTimes(1);
  });
});
