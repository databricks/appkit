export {
  contentTypeFromPath,
  isTextContentType,
} from "../../connectors/files/defaults";

/**
 * Extract the parent directory from a file or directory path.
 *
 * Handles edge cases such as root-level files (`"/file.txt"` → `"/"`),
 * paths without slashes (`"file.txt"` → `""`), and trailing slashes.
 */
export function parentDirectory(path: string): string {
  const normalized =
    path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  const lastSlash = normalized.lastIndexOf("/");

  if (lastSlash > 0) return normalized.substring(0, lastSlash);
  if (normalized.startsWith("/")) return "/";
  return "";
}

/**
 * Sanitize a filename for use in a `Content-Disposition` HTTP header.
 *
 * Redundancy check – Unity Catalog is unlikely to allow filenames with
 * quotes or control characters, but we sanitize defensively to prevent
 * HTTP header injection if upstream constraints ever change.
 */
export function sanitizeFilename(raw: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally stripping control chars for security
  return raw.replace(/["\\]/g, "\\$&").replace(/[\x00-\x1f]/g, "");
}
