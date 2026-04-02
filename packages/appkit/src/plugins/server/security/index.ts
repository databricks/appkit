import corsMiddleware from "cors";
import type { Application } from "express";
import helmet from "helmet";
import { createLogger } from "../../../logging/logger";
import { createCsrfMiddleware } from "./csrf";
import { createErrorHandler } from "./error-handler";
import type { CorsConfig, SecurityConfig } from "./types";

const logger = createLogger("server");

/**
 * Build the default Helmet options based on the environment.
 */
function getDefaultHelmetOptions(isDev: boolean) {
  if (isDev) {
    return {
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'", "http:", "https:", "ws:", "wss:"],
          scriptSrc: ["'self'", "'unsafe-inline'", "http:", "https:"],
          styleSrc: ["'self'", "'unsafe-inline'", "http:", "https:"],
          imgSrc: ["'self'", "http:", "https:", "data:", "blob:"],
          fontSrc: ["'self'", "http:", "https:", "data:"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          connectSrc: ["'self'", "http:", "https:", "ws:", "wss:"],
          frameAncestors: ["'self'"],
        },
      },
      crossOriginOpenerPolicy: { policy: "same-origin" as const },
    };
  }

  return {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["https:", "wss:"],
        scriptSrc: ["https:"],
        styleSrc: ["'self'", "https:", "'unsafe-inline'"],
        imgSrc: ["https:", "data:"],
        fontSrc: ["https:", "data:"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        connectSrc: ["https:", "wss:"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginOpenerPolicy: { policy: "same-origin" as const },
  };
}

/**
 * Build CORS options from CorsConfig + env var.
 */
function buildCorsOptions(config: CorsConfig) {
  const origins = [
    ...(config.allowedOrigins ?? []),
    ...(process.env.APPKIT_CORS_ALLOWED_ORIGINS?.split(",")
      .map((s) => s.trim())
      .filter(Boolean) ?? []),
  ];

  return {
    origin: origins.length > 0 ? origins : (false as false),
    credentials: config.credentials ?? false,
    maxAge: config.maxAge ?? 86400,
    methods: config.allowedMethods ?? ["GET", "POST", "PUT", "DELETE", "PATCH"],
    allowedHeaders: config.allowedHeaders ?? ["Content-Type", "Authorization"],
    optionsSuccessStatus: 204,
  };
}

/**
 * Register security middleware on the Express application.
 *
 * Applied in order:
 * 1. Helmet (security headers + CSP)
 * 2. CORS (if enabled)
 * 3. CSRF (origin validation)
 *
 * All middleware only inspect headers — no body parsing required.
 * Must be registered before route handlers.
 */
export function registerSecurityMiddleware(
  app: Application,
  config?: SecurityConfig,
): void {
  const isDev = process.env.NODE_ENV === "development";
  const features: string[] = [];

  // 1. Helmet (security headers)
  if (config?.helmet !== false) {
    const helmetOptions =
      config?.helmet && typeof config.helmet === "object"
        ? config.helmet // User-provided options fully replace defaults
        : getDefaultHelmetOptions(isDev);

    app.use(helmet(helmetOptions));
    features.push("Helmet (CSP + security headers)");
  }

  // 2. CORS (opt-in)
  if (config?.cors) {
    const corsOptions = buildCorsOptions(config.cors);
    app.use(corsMiddleware(corsOptions));
    features.push("CORS");
  }

  // 3. CSRF (origin validation)
  if (config?.csrf !== false) {
    const csrfConfig =
      config?.csrf && typeof config.csrf === "object" ? config.csrf : undefined;
    app.use(createCsrfMiddleware(csrfConfig));
    features.push("CSRF (origin validation)");
  }

  if (features.length > 0) {
    logger.info("Security middleware enabled: %s", features.join(", "));
  }
}

/**
 * Register the global error handler middleware.
 *
 * Must be registered after all route handlers (Express convention).
 * Acts as a safety net for unhandled errors — plugins can handle
 * their own errors in route handlers without being affected.
 */
export function registerErrorHandler(
  app: Application,
  config?: SecurityConfig,
): void {
  if (config?.errorHandler !== false) {
    const errorConfig =
      config?.errorHandler && typeof config.errorHandler === "object"
        ? config.errorHandler
        : undefined;
    app.use(createErrorHandler(errorConfig));
  }
}
