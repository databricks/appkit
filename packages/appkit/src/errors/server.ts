import { AppKitError } from "./base";

/**
 * Error thrown when server lifecycle operations fail.
 * Use for server start/stop issues, configuration conflicts, etc.
 *
 * @example
 * ```typescript
 * throw new ServerError("Cannot get server when autoStart is true");
 * throw new ServerError("Server not started");
 * ```
 */
export class ServerError extends AppKitError {
  readonly code = "SERVER_ERROR";
  readonly statusCode = 500;
  readonly isRetryable = false;

  /**
   * Create a server error for autoStart conflict
   */
  static autoStartConflict(operation: string): ServerError {
    return new ServerError(`Cannot ${operation} when autoStart is true`, {
      context: { operation },
    });
  }

  /**
   * Create a server error for server not started
   */
  static notStarted(): ServerError {
    return new ServerError(
      "Server not started. Please start the server first by calling the start() method",
    );
  }

  /**
   * Create a server error for Vite dev server not initialized
   */
  static viteNotInitialized(): ServerError {
    return new ServerError("Vite dev server not initialized");
  }

  /**
   * Create a server error for missing client directory
   */
  static clientDirectoryNotFound(searchedPaths: string[]): ServerError {
    return new ServerError(
      `Could not find client directory. Searched for vite.config.ts/js + index.html in: ${searchedPaths.join(", ")}`,
      { context: { searchedPaths } },
    );
  }
}
