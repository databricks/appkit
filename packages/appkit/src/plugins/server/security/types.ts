import type { HelmetOptions } from "helmet";

/** Security configuration for the server plugin. Secure defaults applied when omitted. */
export interface SecurityConfig {
  /** CSRF protection via Origin header validation. Enabled by default in production. Set `false` to disable. */
  csrf?: CsrfConfig | false;

  /** Helmet security headers (CSP, X-Content-Type-Options, X-Frame-Options, COOP, etc.).
   *  Enabled by default with secure presets. Pass custom HelmetOptions to fully replace defaults, or `false` to disable. */
  helmet?: HelmetOptions | false;

  /** CORS configuration. Disabled by default — not registered unless explicitly configured. */
  cors?: CorsConfig | false;

  /** Global error handler preventing info disclosure. Enabled by default. Set `false` to disable (e.g. if you have your own). */
  errorHandler?: ErrorHandlerConfig | false;
}

export interface CsrfConfig {
  /**
   * Additional trusted origins for CSRF validation (beyond DATABRICKS_APP_URL).
   * Also merged with APPKIT_CSRF_ALLOWED_ORIGINS env var (comma-separated).
   * All sources are unioned and deduplicated.
   */
  allowedOrigins?: string[];
}

export interface CorsConfig {
  /**
   * Allowed origins for CORS. Also merged with APPKIT_CORS_ALLOWED_ORIGINS env var (comma-separated).
   * All sources are unioned and deduplicated.
   * If empty after merging, CORS rejects all cross-origin requests (safe default).
   */
  allowedOrigins?: string[];
  /** Allow credentials (cookies). Default: false */
  credentials?: boolean;
  /** Preflight cache duration in seconds. Default: 86400 (24h) */
  maxAge?: number;
  /** Allowed HTTP methods. Default: ["GET","POST","PUT","DELETE","PATCH"] */
  allowedMethods?: string[];
  /** Allowed request headers. Default: ["Content-Type","Authorization"] */
  allowedHeaders?: string[];
}

export interface ErrorHandlerConfig {
  /** Include AppKitError.code in error responses. Default: true (codes are safe to expose and help clients handle errors). */
  includeErrorCode?: boolean;
}
