import { useCallback, useEffect, useRef, useState } from "react";
import {
  CHART_COLOR_VARS_CATEGORICAL,
  CHART_COLOR_VARS_DIVERGING,
  CHART_COLOR_VARS_SEQUENTIAL,
  CHART_UI_VARS,
  FALLBACK_COLORS_CATEGORICAL,
  FALLBACK_COLORS_DIVERGING,
  FALLBACK_COLORS_SEQUENTIAL,
  FALLBACK_UI_TOKENS,
} from "./constants";
import type { ChartColorPalette, ChartUITokens } from "./types";

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

/** Cache for computed chart-chrome tokens (axis text, grid lines). */
let uiTokenCache: ChartUITokens | null = null;

/** Clears both theme caches (palette colors + chrome tokens). */
function clearThemeCaches(): void {
  colorCache.clear();
  uiTokenCache = null;
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
 * Gets chart-chrome tokens (axis text, titles, grid lines) with caching.
 * Each token falls back independently, so a single missing CSS variable never
 * shifts the others. Authored in `hsla` so ECharts/zrender can parse them (the
 * `oklch` semantic tokens cannot be passed to ECharts directly).
 */
function getThemeUITokens(): ChartUITokens {
  if (typeof window === "undefined") return FALLBACK_UI_TOKENS;

  if (uiTokenCache) return uiTokenCache;

  const styles = getComputedStyle(document.documentElement);
  const read = (varName: string, fallback: string): string => {
    const value = styles.getPropertyValue(varName).trim();
    return value || fallback;
  };

  uiTokenCache = {
    axisLabel: read(CHART_UI_VARS.axisLabel, FALLBACK_UI_TOKENS.axisLabel),
    axisTitle: read(CHART_UI_VARS.axisTitle, FALLBACK_UI_TOKENS.axisTitle),
    grid: read(CHART_UI_VARS.grid, FALLBACK_UI_TOKENS.grid),
  };

  return uiTokenCache;
}

// ============================================================================
// Theme Change Subscription (shared)
// ============================================================================

// One matchMedia listener + one MutationObserver for the whole module, shared by
// every chart hook. A theme change resets the caches once, then notifies all
// subscribers — instead of each hook installing its own listener and racing to
// clear the caches the others just repopulated.
const subscribers = new Set<() => void>();
let teardownListeners: (() => void) | null = null;

function handleThemeChange(): void {
  clearThemeCaches();
  // Snapshot so a subscriber mounting/unmounting during notification cannot
  // mutate the set mid-iteration.
  for (const notify of [...subscribers]) notify();
}

function ensureListening(): void {
  if (teardownListeners) return;

  const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  mediaQuery.addEventListener("change", handleThemeChange);

  const observer = new MutationObserver(handleThemeChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-theme", "data-mode"],
  });

  teardownListeners = () => {
    mediaQuery.removeEventListener("change", handleThemeChange);
    observer.disconnect();
  };
}

/**
 * Resets all module-level theme state: clears both caches and drops the shared
 * subscription (removing the matchMedia/MutationObserver listeners). Used by
 * tests to isolate runs; the runtime only ever clears caches, via the dispatcher.
 * @internal
 */
export function resetThemeCache(): void {
  clearThemeCaches();
  subscribers.clear();
  teardownListeners?.();
  teardownListeners = null;
}

/**
 * Subscribes `onChange` to theme changes (system color scheme via matchMedia, or
 * a theme attribute on the root element). Listeners are shared and ref-counted,
 * so each hook subscribes once per mount regardless of how `onChange`'s identity
 * changes between renders.
 */
function useThemeChangeEffect(onChange: () => void): void {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const subscriber = () => onChangeRef.current();
    subscribers.add(subscriber);
    ensureListening();

    return () => {
      subscribers.delete(subscriber);
      if (subscribers.size === 0 && teardownListeners) {
        teardownListeners();
        teardownListeners = null;
      }
    };
  }, []);
}

// ============================================================================
// Hooks
// ============================================================================

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

  // Re-resolve colors when the theme changes (the cache is reset centrally).
  const updateColors = useCallback(() => {
    setColors(getThemeColors(palette));
  }, [palette]);

  useThemeChangeEffect(updateColors);

  return colors;
}

/**
 * Hook to get the chart-chrome tokens (axis text, titles, grid lines) with
 * automatic updates on theme change. Pass the result into the ECharts option
 * builders so axis labels, lines, legends, and titles follow the active theme.
 */
export function useChartUITokens(): ChartUITokens {
  const [tokens, setTokens] = useState<ChartUITokens>(() =>
    typeof window === "undefined" ? FALLBACK_UI_TOKENS : getThemeUITokens(),
  );

  // Re-resolve tokens when the theme changes (the cache is reset centrally).
  const updateTokens = useCallback(() => {
    setTokens(getThemeUITokens());
  }, []);

  useThemeChangeEffect(updateTokens);

  return tokens;
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
