import { AppKitError } from "./base";

/**
 * Error thrown when remote tunnel operations fail.
 * Use for tunnel connection issues, message parsing failures, etc.
 *
 * @example
 * ```typescript
 * throw new TunnelError("No tunnel connection available");
 * throw new TunnelError("Failed to parse WebSocket message", { cause: parseError });
 * ```
 */
export class TunnelError extends AppKitError {
  readonly code = "TUNNEL_ERROR";
  readonly statusCode = 502;
  readonly isRetryable = true;

  /**
   * Create a tunnel error for missing tunnel getter
   */
  static getterNotRegistered(): TunnelError {
    return new TunnelError(
      "Tunnel getter not registered for DevFileReader singleton",
    );
  }

  /**
   * Create a tunnel error for no available connection
   */
  static noConnection(): TunnelError {
    return new TunnelError("No tunnel connection available for file read");
  }

  /**
   * Create a tunnel error for asset fetch failure
   */
  static fetchFailed(path: string, cause?: Error): TunnelError {
    return new TunnelError("Failed to fetch asset", {
      cause,
      context: { path },
    });
  }

  /**
   * Create a tunnel error for message parsing failure
   */
  static parseError(messageType: string, cause?: Error): TunnelError {
    return new TunnelError(`Failed to parse ${messageType} message`, {
      cause,
      context: { messageType },
    });
  }
}
