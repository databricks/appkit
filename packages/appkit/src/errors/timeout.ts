import { ExecutionError } from "./execution";

/** An AppKit execution deadline expired, independently of caller cancellation. */
export class ExecutionTimeoutError extends ExecutionError {
  constructor(timeoutMs: number, cause?: Error) {
    super(`Operation timed out after ${timeoutMs} ms`, {
      cause,
      context: { timeoutMs },
      errorCode: "TIMEOUT",
      clientMessage: "Query timed out, please try again",
    });
  }
}
