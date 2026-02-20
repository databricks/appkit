export const EXTENSION_CONTENT_TYPES: Record<string, string> = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/vnd.microsoft.icon",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".ts": "text/typescript",
  ".py": "text/x-python",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".xml": "application/xml",
  ".yaml": "application/x-yaml",
  ".yml": "application/x-yaml",
  ".sql": "application/sql",
  ".pdf": "application/pdf",
  ".ipynb": "application/x-ipynb+json",
  ".parquet": "application/vnd.apache.parquet",
  ".zip": "application/zip",
  ".gz": "application/gzip",
});

const TEXT_KEYWORDS = ["json", "xml", "yaml", "sql", "javascript"] as const;

/**
 * Determine whether a content type represents text.
 *
 * Returns `true` for any `text/*` type and for known structured-text types
 * such as JSON, XML, YAML, SQL, and JavaScript.
 *
 * @param contentType - MIME content type string to check.
 * @returns `true` if the content type is text-based.
 */
export function isTextContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  if (contentType.startsWith("text/")) return true;
  return TEXT_KEYWORDS.some((kw) => contentType.includes(kw));
}

/**
 * Resolve the MIME content type for a file path.
 *
 * Resolution order:
 * 1. Custom type map (if the extension matches a key in `customTypes`).
 * 2. Built-in extension map ({@link EXTENSION_CONTENT_TYPES}).
 * 3. The `reported` type from the server, or `application/octet-stream` as a fallback.
 *
 * @param filePath - File path used to extract the extension.
 * @param reported - Content type reported by the server (used as fallback).
 * @param customTypes - Optional map of extensions to MIME types that takes priority.
 * @returns The resolved MIME content type string.
 */
/**
 * MIME types that are safe to serve inline (i.e. browsers cannot execute
 * scripts from them). Any type **not** in this set should be forced to
 * download via `Content-Disposition: attachment` when served by the `/raw`
 * endpoint to prevent stored-XSS attacks.
 */
export const SAFE_INLINE_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/vnd.microsoft.icon",
  "text/plain",
  "text/csv",
  "text/markdown",
  "application/json",
  "application/pdf",
]);

/**
 * Check whether a content type is safe to serve inline.
 *
 * @param contentType - MIME content type string.
 * @returns `true` if the type is in the safe-inline allowlist.
 */
export function isSafeInlineContentType(contentType: string): boolean {
  return SAFE_INLINE_CONTENT_TYPES.has(contentType);
}

/**
 * Resolve the MIME content type for a file path.
 *
 * @param filePath - Path to the file (only the extension is inspected).
 * @param reported - Optional MIME type reported by the caller; used as fallback when the extension is unknown.
 * @param customTypes - Optional map of extension → MIME type overrides (e.g. `{ ".csv": "text/csv" }`).
 * @returns The resolved MIME content type string.
 */
export function contentTypeFromPath(
  filePath: string,
  reported?: string,
  customTypes?: Record<string, string>,
): string {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  const fromCustom = customTypes?.[ext];

  if (fromCustom) {
    return fromCustom;
  }

  const fromExt = EXTENSION_CONTENT_TYPES[ext];

  if (fromExt) {
    return fromExt;
  }

  return reported ?? "application/octet-stream";
}
