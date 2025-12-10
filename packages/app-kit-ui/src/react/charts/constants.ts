// ============================================================================
// Shared Constants for Chart Components
// ============================================================================

// Re-export field patterns from shared constants
export {
  DATE_FIELD_PATTERNS,
  METADATA_DATE_PATTERNS,
  NAME_FIELD_PATTERNS,
} from "@/js/constants";

// ============================================================================
// Chart Color Palettes
// ============================================================================

/** CSS variable names for categorical chart colors (distinct categories) */
export const CHART_COLOR_VARS_CATEGORICAL = [
  "--chart-cat-1",
  "--chart-cat-2",
  "--chart-cat-3",
  "--chart-cat-4",
  "--chart-cat-5",
  "--chart-cat-6",
  "--chart-cat-7",
  "--chart-cat-8",
] as const;

/** CSS variable names for sequential chart colors (low → high) */
export const CHART_COLOR_VARS_SEQUENTIAL = [
  "--chart-seq-1",
  "--chart-seq-2",
  "--chart-seq-3",
  "--chart-seq-4",
  "--chart-seq-5",
  "--chart-seq-6",
  "--chart-seq-7",
  "--chart-seq-8",
] as const;

/** CSS variable names for diverging chart colors (negative ↔ positive) */
export const CHART_COLOR_VARS_DIVERGING = [
  "--chart-div-1",
  "--chart-div-2",
  "--chart-div-3",
  "--chart-div-4",
  "--chart-div-5",
  "--chart-div-6",
  "--chart-div-7",
  "--chart-div-8",
] as const;

/** Legacy: CSS variable names for chart colors (aliases to categorical) */
export const CHART_COLOR_VARS = [
  "--chart-1",
  "--chart-2",
  "--chart-3",
  "--chart-4",
  "--chart-5",
  "--chart-6",
  "--chart-7",
  "--chart-8",
] as const;

// ============================================================================
// Fallback Colors (when CSS variables unavailable)
// ============================================================================

/** Fallback categorical colors */
export const FALLBACK_COLORS_CATEGORICAL = [
  "hsla(221, 83%, 53%, 1)", // Blue
  "hsla(160, 60%, 45%, 1)", // Teal
  "hsla(291, 47%, 51%, 1)", // Purple
  "hsla(35, 92%, 55%, 1)", // Amber
  "hsla(349, 72%, 52%, 1)", // Rose
  "hsla(189, 75%, 42%, 1)", // Cyan
  "hsla(271, 55%, 60%, 1)", // Lavender
  "hsla(142, 55%, 45%, 1)", // Emerald
];

/** Fallback sequential colors (light → dark blue) */
export const FALLBACK_COLORS_SEQUENTIAL = [
  "hsla(221, 70%, 94%, 1)",
  "hsla(221, 72%, 85%, 1)",
  "hsla(221, 74%, 74%, 1)",
  "hsla(221, 76%, 63%, 1)",
  "hsla(221, 78%, 52%, 1)",
  "hsla(221, 80%, 42%, 1)",
  "hsla(221, 82%, 32%, 1)",
  "hsla(221, 84%, 24%, 1)",
];

/** Fallback diverging colors (blue → red) */
export const FALLBACK_COLORS_DIVERGING = [
  "hsla(221, 80%, 35%, 1)", // Strong negative
  "hsla(221, 70%, 50%, 1)",
  "hsla(221, 55%, 65%, 1)",
  "hsla(221, 35%, 82%, 1)", // Weak negative
  "hsla(10, 35%, 82%, 1)", // Weak positive
  "hsla(10, 60%, 65%, 1)",
  "hsla(10, 72%, 50%, 1)",
  "hsla(10, 80%, 40%, 1)", // Strong positive
];

/** Legacy: Fallback colors (aliases to categorical) */
export const FALLBACK_COLORS = FALLBACK_COLORS_CATEGORICAL;
