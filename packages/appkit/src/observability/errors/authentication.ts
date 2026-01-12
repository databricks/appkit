import { AppKitError } from "./base";

/**
 * Error thrown when authentication fails.
 * Use for missing tokens, invalid credentials, or authorization failures.
 *
 * @example
 * ```typescript
 * throw new AuthenticationError("User token is required");
 * throw new AuthenticationError("Failed to generate credentials", { cause: originalError });
 * ```
 */
export class AuthenticationError extends AppKitError {
  readonly code = "AUTHENTICATION_ERROR";
  readonly statusCode = 401;
  readonly isRetryable = false;

  /**
   * Create an authentication error for missing token
   */
  static missingToken(tokenType = "access token"): AuthenticationError {
    return new AuthenticationError(`Missing ${tokenType} in request headers`, {
      context: { tokenType },
    });
  }

  /**
   * Create an authentication error for missing user identity
   */
  static missingUserId(): AuthenticationError {
    return new AuthenticationError(
      "User ID not available in request headers. " +
        "Ensure the request has the x-forwarded-user header.",
    );
  }

  /**
   * Create an authentication error for credential generation failure
   */
  static credentialsFailed(
    instance: string,
    cause?: Error,
  ): AuthenticationError {
    return new AuthenticationError(
      `Failed to generate credentials for instance: ${instance}`,
      { cause, context: { instance } },
    );
  }

  /**
   * Create an authentication error for failed user lookup
   */
  static userLookupFailed(cause?: Error): AuthenticationError {
    return new AuthenticationError(
      "Failed to get current user from Databricks workspace",
      { cause },
    );
  }
}
