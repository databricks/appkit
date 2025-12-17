// ============================================================================
// Shared Constants for Field Detection
// ============================================================================
// These patterns are used by both Arrow processing and chart normalization
// to detect field types from column names.

/** Field patterns to detect date/time fields by name */
export const DATE_FIELD_PATTERNS = [
  "date",
  "time",
  "period",
  "timestamp",
] as const;

/** Field patterns to detect name/category fields by name */
export const NAME_FIELD_PATTERNS = [
  "name",
  "label",
  "app",
  "user",
  "creator",
  "browser",
  "category",
] as const;

/** Patterns that indicate a date field is metadata, not for charting */
export const METADATA_DATE_PATTERNS = [
  "created",
  "updated",
  "modified",
  "deleted",
  "last_",
] as const;
