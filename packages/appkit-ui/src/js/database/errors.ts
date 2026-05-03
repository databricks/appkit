/**
 * Thrown by the browser database client when a request returns a non-2xx
 * response. The original `status` and any parsed JSON body are preserved so
 * consumers can surface detail to users or branch on error shape.
 */
export class DatabaseHTTPError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "DatabaseHTTPError";
  }
}
