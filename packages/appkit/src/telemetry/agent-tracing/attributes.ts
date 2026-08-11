export const DEFAULT_TRACE_VALUE_MAX_BYTES = 64 * 1024;
export const REDACTED_TRACE_VALUE = "[REDACTED]";

export const DEFAULT_TRACE_REDACT_KEYS = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "api-key",
  "api_key",
  "apikey",
  "x-api-key",
  "token",
  "access-token",
  "access_token",
  "refresh-token",
  "refresh_token",
  "databricks-token",
  "databricks_token",
  "password",
  "secret",
  "client-secret",
  "client_secret",
  "credential",
  "credentials",
] as const;
