import { AppKitError } from "./base";

export class SidecarError extends AppKitError {
  readonly code = "SIDECAR_ERROR";
  readonly statusCode: number;
  readonly isRetryable: boolean;

  constructor(
    message: string,
    options?: {
      cause?: Error;
      context?: Record<string, unknown>;
      statusCode?: number;
      isRetryable?: boolean;
    },
  ) {
    super(message, options);
    this.statusCode = options?.statusCode ?? 503;
    this.isRetryable = options?.isRetryable ?? true;
  }

  static startupFailed(command: string, timeout: number): SidecarError {
    return new SidecarError(
      `Sidecar process '${command}' failed to become ready within ${timeout}ms`,
      { context: { command, timeout }, isRetryable: false },
    );
  }

  static processCrashed(
    command: string,
    exitCode: number | null,
  ): SidecarError {
    return new SidecarError(
      `Sidecar process '${command}' exited unexpectedly with code ${exitCode}`,
      { context: { command, exitCode } },
    );
  }

  static maxRestartsExceeded(
    command: string,
    maxRestarts: number,
  ): SidecarError {
    return new SidecarError(
      `Sidecar process '${command}' exceeded maximum restarts (${maxRestarts})`,
      { context: { command, maxRestarts }, isRetryable: false },
    );
  }

  static proxyFailed(cause?: Error): SidecarError {
    return new SidecarError("Failed to proxy request to sidecar process", {
      cause,
      statusCode: 502,
    });
  }

  /** Child process did not respond within the configured requestTimeout. */
  static bridgeTimeout(requestId: number, timeout: number): SidecarError {
    return new SidecarError(
      `Sidecar request ${requestId} timed out after ${timeout}ms`,
      {
        context: { requestId, timeout, errorType: "bridge_timeout" },
        statusCode: 504,
        isRetryable: true,
      },
    );
  }

  /** Child process returned a JSON-RPC error response. */
  static bridgeRequestFailed(
    message: string,
    rpcError: { code: number; data?: unknown },
  ): SidecarError {
    return new SidecarError(`Sidecar request failed: ${message}`, {
      context: {
        rpcErrorCode: rpcError.code,
        rpcErrorData: rpcError.data,
        errorType: "bridge_request_failed",
      },
      statusCode: 502,
      isRetryable: rpcError.code >= -32000,
    });
  }

  /** Too many in-flight requests to the child process. */
  static concurrencyExhausted(maxConcurrency: number): SidecarError {
    return new SidecarError(
      `Sidecar concurrency limit reached (${maxConcurrency} pending requests)`,
      {
        context: { maxConcurrency, errorType: "concurrency_exhausted" },
        statusCode: 503,
        isRetryable: true,
      },
    );
  }

  /** stdin write failed — child process may have crashed. */
  static stdinWriteFailed(cause?: Error): SidecarError {
    return new SidecarError("Failed to write to sidecar stdin", {
      cause,
      context: { errorType: "stdin_write_failed" },
      statusCode: 502,
      isRetryable: true,
    });
  }
}
