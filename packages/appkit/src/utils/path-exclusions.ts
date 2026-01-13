import type { IncomingMessage } from "node:http";

/**
 * Paths and patterns to exclude from tracing and logging.
 * Requests matching these will not create spans or WideEvents.
 */
export const EXCLUDED_PATH_PREFIXES = [
  // Vite dev server internals
  "/@fs/",
  "/@vite/",
  "/@id/",
  "/@react-refresh",
  "/src/", // Vite HMR source files
  "/node_modules/",

  // Static assets and common paths
  "/favicon.ico",
  "/_next/",
  "/static/",

  // Health checks
  "/health",
  "/metrics",
];

/**
 * File extensions to exclude from tracing.
 * These are typically static assets that don't need tracing.
 */
export const EXCLUDED_EXTENSIONS = [
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".css",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".map", // Source maps
  ".js", // Static JS files (not API endpoints)
];

/**
 * Check if a request should be ignored for tracing.
 * This is the primary filter used by HttpInstrumentation.
 */
export function shouldIgnoreRequest(request: IncomingMessage): boolean {
  const url = request.url;
  if (!url) return false;

  // Remove query string for path matching
  const path = url.split("?")[0];

  return shouldExcludePath(path);
}

/**
 * Check if a path should be excluded from tracing/logging.
 * Returns true if path should be excluded, false otherwise.
 */
export function shouldExcludePath(path: string | undefined): boolean {
  if (typeof path !== "string") return false;

  // Remove query string
  const cleanPath = path.split("?")[0];
  const lowerPath = cleanPath.toLowerCase();

  // Check path prefixes
  for (const prefix of EXCLUDED_PATH_PREFIXES) {
    if (cleanPath.startsWith(prefix) || cleanPath.includes(prefix)) {
      return true;
    }
  }

  // Check file extensions (but not for /api/ routes)
  if (!cleanPath.startsWith("/api/")) {
    for (const ext of EXCLUDED_EXTENSIONS) {
      if (lowerPath.endsWith(ext)) {
        return true;
      }
    }
  }

  return false;
}
