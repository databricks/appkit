import { AppKitError } from "../../errors/base";

/** Statuses worth retrying: rate limited, or the service is briefly unavailable. */
const RETRYABLE_STATUS_CODES = new Set([429, 503]);

/**
 * A client-safe error returned when an AI Functions request fails.
 */
export class AiFunctionsRequestError extends AppKitError {
  readonly code = "AI_FUNCTIONS_REQUEST_ERROR";
  readonly isRetryable: boolean;
  readonly statusCode: number;
  readonly functionName: "classify" | "extract" | "decide";

  constructor(
    message: string,
    options: {
      statusCode: number;
      functionName: "classify" | "extract" | "decide";
      /** Set only for a 401, so AppKit can report an expired user token. */
      cause?: Error;
    },
  ) {
    super(message, { clientMessage: message, cause: options.cause });
    this.statusCode = options.statusCode;
    this.functionName = options.functionName;
    this.isRetryable = RETRYABLE_STATUS_CODES.has(options.statusCode);
  }
}
