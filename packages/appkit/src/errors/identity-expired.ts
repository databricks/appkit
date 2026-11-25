import { AppKitError } from "./base";

/** The downstream service rejected the active caller's credentials. */
export class IdentityExpiredError extends AppKitError {
  readonly code = "IDENTITY_EXPIRED";
  readonly statusCode = 401;
  readonly isRetryable = false;

  constructor(readonly tokenFingerprint?: string) {
    const message =
      "Caller credentials were rejected or expired. Reauthenticate and retry with a fresh user token.";
    // Do not retain upstream errors: SDK errors may contain authorization headers.
    super(message, {
      clientMessage: message,
      context: { fingerprint: tokenFingerprint },
    });
  }
}

interface HttpFailure {
  status?: unknown;
  statusCode?: unknown;
  // Modular SDK (sdk-core) ApiError.
  httpStatusCode?: unknown;
  httpBody?: unknown;
  response?: { status?: unknown };
  message?: unknown;
  cause?: unknown;
}

// Databricks rejects expired/revoked/malformed tokens with 403, not 401:
// PATs as JSON "Invalid access token.", OAuth tokens as plain-text "Invalid Token".
const INVALID_TOKEN = /\binvalid (access )?token\b/i;

function hasStatus(value: HttpFailure, status: number): boolean {
  return (
    value.status === status ||
    value.statusCode === status ||
    value.httpStatusCode === status ||
    value.response?.status === status
  );
}

function saysInvalidToken(value: HttpFailure): boolean {
  // sdk-core leaves `message` empty for a non-JSON body, so read the body too.
  const body =
    value.httpBody instanceof Uint8Array
      ? new TextDecoder().decode(value.httpBody)
      : "";
  const message = typeof value.message === "string" ? value.message : "";
  return INVALID_TOKEN.test(`${message} ${body}`);
}

/**
 * Recognize rejected caller credentials in structured HTTP failures (a 401, or
 * a 403 reporting an invalid token), including connector cause wrappers.
 */
export function isUnauthorized(error: unknown): boolean {
  const seen = new Set<object>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const value = current as HttpFailure;
    if (
      !(current instanceof AppKitError) &&
      (hasStatus(value, 401) ||
        (hasStatus(value, 403) && saysInvalidToken(value)))
    )
      return true;
    current = value.cause;
  }
  return false;
}
