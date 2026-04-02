import type { NextFunction, Request, Response } from "express";
import { createLogger } from "../../../logging/logger";
import type { CsrfConfig } from "./types";

const logger = createLogger("server");

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);

/**
 * Parse a comma-separated env var into trimmed, non-empty strings.
 */
function parseEnvOrigins(envVar: string | undefined): string[] {
  if (!envVar) return [];
  return envVar
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Build the set of trusted origins from all sources:
 * 1. DATABRICKS_APP_URL env var
 * 2. Config allowedOrigins
 * 3. APPKIT_CSRF_ALLOWED_ORIGINS env var
 */
function buildTrustedOrigins(config?: CsrfConfig): Set<string> {
  const origins = new Set<string>();

  const appUrl = process.env.DATABRICKS_APP_URL;
  if (appUrl) {
    try {
      origins.add(new URL(appUrl).origin.toLowerCase());
    } catch {
      logger.warn(
        "DATABRICKS_APP_URL is not a valid URL: %s — skipping for CSRF",
        appUrl,
      );
    }
  }

  for (const o of config?.allowedOrigins ?? []) {
    origins.add(o.toLowerCase().replace(/\/$/, ""));
  }

  for (const o of parseEnvOrigins(process.env.APPKIT_CSRF_ALLOWED_ORIGINS)) {
    origins.add(o.toLowerCase().replace(/\/$/, ""));
  }

  return origins;
}

/**
 * Check if an origin matches localhost (any port).
 */
function isLocalhostOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.hostname === "localhost" || url.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

/**
 * Same-origin heuristic: compare Origin against Host header.
 * Used as fallback when no trusted origins are configured.
 */
function isSameOrigin(origin: string, req: Request): boolean {
  const host = req.headers.host;
  if (!host) return false;

  try {
    const originUrl = new URL(origin);
    const originHost = originUrl.host.toLowerCase();
    return originHost === host.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Create CSRF protection middleware using Origin header validation.
 *
 * - Applies to state-changing methods (POST, PUT, DELETE, PATCH) only
 * - Allows absent/empty Origin (same-origin browser or non-browser client)
 * - Rejects `Origin: null` (sandboxed iframe attack vector)
 * - In dev mode, auto-allows localhost origins
 * - Falls back to Host header comparison when no trusted origins are configured
 */
export function createCsrfMiddleware(
  config?: CsrfConfig | false,
): (req: Request, res: Response, next: NextFunction) => void {
  if (config === false) {
    return (_req, _res, next) => next();
  }

  const isDev = process.env.NODE_ENV === "development";
  const trustedOrigins = buildTrustedOrigins(
    config === undefined ? undefined : config,
  );

  if (!isDev && trustedOrigins.size === 0) {
    logger.warn(
      "DATABRICKS_APP_URL not set and no CSRF origins configured — CSRF will use Host header fallback. Set DATABRICKS_APP_URL for full protection.",
    );
  }

  return (req: Request, res: Response, next: NextFunction) => {
    if (!STATE_CHANGING_METHODS.has(req.method)) {
      return next();
    }

    const origin = req.headers.origin;

    // No Origin header — allow (same-origin or non-browser client)
    if (!origin || origin === "") {
      return next();
    }

    // Reject Origin: null (sandboxed iframe, data: URI)
    if (origin === "null") {
      logger.debug("CSRF rejected: null Origin on %s %s", req.method, req.path);
      return res.status(403).json(
        isDev
          ? {
              error: "CSRF validation failed",
              detail:
                "Origin: null rejected — possible sandboxed iframe or data: URI",
            }
          : { error: "CSRF validation failed" },
      );
    }

    const normalizedOrigin = origin.toLowerCase().replace(/\/$/, "");

    // In dev mode, allow localhost origins
    if (isDev && isLocalhostOrigin(normalizedOrigin)) {
      return next();
    }

    // In production, reject non-HTTPS origins
    if (!isDev && !normalizedOrigin.startsWith("https://")) {
      logger.debug(
        "CSRF rejected: non-HTTPS Origin %s on %s %s",
        origin,
        req.method,
        req.path,
      );
      return res.status(403).json(
        isDev
          ? {
              error: "CSRF validation failed",
              detail: `Origin must use HTTPS in production: ${origin}`,
            }
          : { error: "CSRF validation failed" },
      );
    }

    // Check against trusted origins
    if (trustedOrigins.has(normalizedOrigin)) {
      return next();
    }

    // Fallback: same-origin heuristic (compare Origin vs Host)
    if (trustedOrigins.size === 0 && isSameOrigin(origin, req)) {
      return next();
    }

    logger.debug(
      "CSRF rejected: Origin %s not trusted on %s %s",
      origin,
      req.method,
      req.path,
    );
    return res.status(403).json(
      isDev
        ? {
            error: "CSRF validation failed",
            detail: `Origin ${origin} not in trusted set`,
          }
        : { error: "CSRF validation failed" },
    );
  };
}
