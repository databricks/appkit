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

/** Recognize structured HTTP failures, including connector cause wrappers. */
export function isUnauthorized(error: unknown): boolean {
  const seen = new Set<object>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const value = current as {
      status?: unknown;
      statusCode?: unknown;
      response?: { status?: unknown };
      cause?: unknown;
    };
    if (
      !(current instanceof AppKitError) &&
      (value.status === 401 ||
        value.statusCode === 401 ||
        value.response?.status === 401)
    )
      return true;
    current = value.cause;
  }
  return false;
}
