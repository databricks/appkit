import type express from "express";

/**
 * Wrap an Express handler so synchronous throws and async rejections are
 * forwarded to the error-handling middleware via `next(err)`.
 *
 * Express 4 does not catch rejected promises from async handlers — a
 * rejection (e.g. `asUser()` throwing `AuthenticationError` before any
 * response is written) escapes as an unhandledRejection, which leaves the
 * request hanging and crashes Node by default.
 *
 * Error-handling middleware (arity 4, `(err, req, res, next)`) is returned
 * unchanged: Express identifies it by function arity, so wrapping it would
 * silently turn it into a regular handler.
 *
 * Note: handlers must RETURN their promise (e.g. `(req, res) =>
 * this._handle(req, res)` or `async (req, res) => { await ... }`) for
 * rejections to be caught — a fire-and-forget body like
 * `(req, res) => { this._handle(req, res); }` hides the promise from the
 * wrapper and rejections escape as unhandledRejection again.
 */
export function forwardAsyncErrors(
  handler: (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => unknown,
): express.RequestHandler {
  if (handler.length > 3) return handler as express.RequestHandler;
  return (req, res, next) =>
    Promise.resolve()
      .then(() => handler(req, res, next))
      .catch(next);
}
