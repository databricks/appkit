import type { NextFunction, Request, Response } from "express";
import { AppKitError } from "../../../errors/base";
import { createLogger } from "../../../logging/logger";
import type { ErrorHandlerConfig } from "./types";

const logger = createLogger("server");

/**
 * Create a global error handler middleware that prevents information disclosure.
 *
 * - Logs full error details server-side (using AppKitError.toJSON() for safe sanitization)
 * - Returns generic error messages in production
 * - Includes message/stack in dev mode for debugging
 * - Handles SyntaxError from JSON body parsing (returns 400)
 * - Respects headersSent to avoid double-send
 */
export function createErrorHandler(
  config?: ErrorHandlerConfig | false,
): (err: Error, req: Request, res: Response, next: NextFunction) => void {
  if (config === false) {
    return (_err, _req, _res, next) => next(_err);
  }

  const isDev = process.env.NODE_ENV === "development";
  const includeErrorCode = config?.includeErrorCode ?? true;

  return (err: Error, _req: Request, res: Response, next: NextFunction) => {
    // If headers already sent, delegate to Express default handler
    if (res.headersSent) {
      return next(err);
    }

    // Log the error server-side
    if (err instanceof AppKitError) {
      logger.error("Unhandled error: %O", err.toJSON());
    } else {
      logger.error("Unhandled error: %s", err.message);
      if (err.stack) {
        logger.debug("Stack trace: %s", err.stack);
      }
    }

    // Handle JSON parsing errors from express.json()
    if (
      err instanceof SyntaxError &&
      "status" in err &&
      (err as { status?: number }).status === 400
    ) {
      return res
        .status(400)
        .json(
          isDev
            ? { error: "Bad Request", message: err.message }
            : { error: "Bad Request" },
        );
    }

    // Handle AppKitError with proper status code
    if (err instanceof AppKitError) {
      const body: Record<string, unknown> = {
        error: isDev ? err.message : "Internal Server Error",
      };

      if (includeErrorCode) {
        body.code = err.code;
      }

      if (isDev && err.stack) {
        body.stack = err.stack;
      }

      return res.status(err.statusCode).json(body);
    }

    // Generic error
    return res.status(500).json(
      isDev
        ? {
            error: err.message || "Internal Server Error",
            stack: err.stack,
          }
        : { error: "Internal Server Error" },
    );
  };
}
