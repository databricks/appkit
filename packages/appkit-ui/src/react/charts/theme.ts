import { useEffect, useState } from "react";
import {
  CHART_COLOR_VARS_CATEGORICAL,
  CHART_COLOR_VARS_DIVERGING,
  CHART_COLOR_VARS_SEQUENTIAL,
  FALLBACK_COLORS_CATEGORICAL,
  FALLBACK_COLORS_DIVERGING,
  FALLBACK_COLORS_SEQUENTIAL,
} from "./constants";
import type { ChartColorPalette } from "./types";

// ============================================================================
// Theme Colors (resolved from CSS variables)
// ============================================================================

const PALETTE_CONFIG: Record<
  ChartColorPalette,
  { vars: readonly string[]; fallback: string[] }
> = {
  categorical: {
    vars: CHART_COLOR_VARS_CATEGORICAL,
    fallback: FALLBACK_COLORS_CATEGORICAL,
  },
  sequential: {
    vars: CHART_COLOR_VARS_SEQUENTIAL,
    fallback: FALLBACK_COLORS_SEQUENTIAL,
  },
  diverging: {
    vars: CHART_COLOR_VARS_DIVERGING,
    fallback: FALLBACK_COLORS_DIVERGING,
  },
};

// ============================================================================
// Module-Level Caching
// ============================================================================

/**
 * Cache for computed theme colors to avoid repeated CSS variable lookups.
 * Cache is cleared when theme change events fire (MutationObserver/matchMedia).
 */
const colorCache = new Map<string, string[]>();

/**
 * Clears the theme color cache.
 * Called when theme change events fire, or for testing when mocks change.
 * @internal
 */
export function resetThemeColorCache(): void {
  colorCache.clear();
}

/**
 * Gets theme colors with module-level caching.
 * Avoids repeated CSS variable lookups for the same palette within a theme.
 */
function getThemeColors(palette: ChartColorPalette = "categorical"): string[] {
  const config = PALETTE_CONFIG[palette];

  if (typeof window === "undefined") return config.fallback;

  // Return cached colors if available
  const cached = colorCache.get(palette);
  if (cached) {
    return cached;
  }

  // Compute colors from CSS variables
  const styles = getComputedStyle(document.documentElement);
  const colors: string[] = [];

  for (const varName of config.vars) {
    const value = styles.getPropertyValue(varName).trim();
    if (value) colors.push(value);
  }

  const result = colors.length > 0 ? colors : config.fallback;

  // Cache the result
  colorCache.set(palette, result);

  return result;
}

/**
 * Hook to get theme colors with automatic updates on theme change.
 * Re-resolves CSS variables when color scheme or theme attributes change.
 *
 * @param palette - Color palette type: "categorical" (default), "sequential", or "diverging"
 */
export function useThemeColors(
  palette: ChartColorPalette = "categorical",
): string[] {
  const [colors, setColors] = useState<string[]>(() =>
    typeof window === "undefined"
      ? PALETTE_CONFIG[palette].fallback
      : getThemeColors(palette),
  );

  useEffect(() => {
    // Clear cache and re-fetch colors when theme changes
    const updateColors = () => {
      resetThemeColorCache();
      setColors(getThemeColors(palette));
    };

    // Listen for system color scheme changes
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    mediaQuery.addEventListener("change", updateColors);

    // Listen for theme attribute changes (e.g., class="dark", data-theme="dark")
    const observer = new MutationObserver(updateColors);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme", "data-mode"],
    });

    return () => {
      mediaQuery.removeEventListener("change", updateColors);
      observer.disconnect();
    };
  }, [palette]);

  return colors;
}

/**
 * Hook to get all three color palettes at once.
 * Useful when a component needs access to multiple palette types.
 */
export function useAllThemeColors(): {
  categorical: string[];
  sequential: string[];
  diverging: string[];
} {
  const categorical = useThemeColors("categorical");
  const sequential = useThemeColors("sequential");
  const diverging = useThemeColors("diverging");

  return { categorical, sequential, diverging };
}
