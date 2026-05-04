/**
 * Thrown by the browser database client when a request returns a non-2xx
 * response. The HTTP status is exposed as `statusCode` to match the rest of
 * AppKit's error surface (`AppKitError.statusCode`); a deprecated `status`
 * alias is kept for compatibility with existing call sites.
 */
export class DatabaseHTTPError extends Error {
  /** HTTP status code returned by the server. */
  readonly statusCode: number;
  /** Parsed JSON body or text returned by the server, when available. */
  readonly body?: unknown;

  constructor(statusCode: number, message: string, body?: unknown) {
    super(message);
    this.name = "DatabaseHTTPError";
    this.statusCode = statusCode;
    this.body = body;
  }

  /** @deprecated Use `statusCode`. */
  get status(): number {
    return this.statusCode;
  }
}
