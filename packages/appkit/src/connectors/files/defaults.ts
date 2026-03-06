/**
 * Default maximum size for `read()` in bytes (10 MB).
 * Prevents loading very large files into memory as a string.
 * Use `download()` for files larger than this limit.
 */
export const FILES_MAX_READ_SIZE = 10 * 1024 * 1024; // 10 MB

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
 * MIME types that must never be allowed in `customContentTypes` because
 * browsers can execute scripts from them. Allowing these in custom mappings
 * would bypass the `/raw` endpoint's forced-download protection for unsafe types.
 */
export const DANGEROUS_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "text/html",
  "text/javascript",
  "application/javascript",
  "application/xhtml+xml",
  "image/svg+xml",
]);

/**
 * Validate that a `customContentTypes` map does not contain any MIME types
 * that would bypass XSS protections when served inline.
 *
 * @param customTypes - Map of extension → MIME type overrides.
 * @throws {Error} if any mapping resolves to a dangerous MIME type.
 */
export function validateCustomContentTypes(
  customTypes: Record<string, string>,
): void {
  for (const [ext, mimeType] of Object.entries(customTypes)) {
    const normalized = mimeType.toLowerCase().trim();
    if (DANGEROUS_CONTENT_TYPES.has(normalized)) {
      throw new Error(
        `Unsafe customContentTypes mapping: "${ext}" → "${mimeType}". ` +
          `MIME type "${normalized}" can execute scripts in browsers and is not allowed. ` +
          "Remove this mapping or use a safe content type.",
      );
    }
  }
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
  const dotIndex = filePath.lastIndexOf(".");
  const ext = dotIndex > 0 ? filePath.slice(dotIndex).toLowerCase() : "";
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
