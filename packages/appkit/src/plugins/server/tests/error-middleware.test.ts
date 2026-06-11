import { afterEach, describe, expect, test, vi } from "vitest";
import { AuthenticationError, ValidationError } from "../../../errors";
import { errorHandlerMiddleware } from "../index";

function makeReq() {
  return { method: "GET", originalUrl: "/api/genie/default/messages" } as any;
}

function makeRes(headersSent = false) {
  const res: any = { headersSent };
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

describe("errorHandlerMiddleware", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    vi.restoreAllMocks();
  });

  test("maps AppKitError to its statusCode with its message", () => {
    const res = makeRes();
    const next = vi.fn();

    errorHandlerMiddleware(
      AuthenticationError.missingToken("user token"),
      makeReq(),
      res,
      next,
    );

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: "Missing user token in request headers",
    });
    expect(next).not.toHaveBeenCalled();
  });

  test("preserves AppKitError messages in production (client-safe by design)", () => {
    process.env.NODE_ENV = "production";
    const res = makeRes();

    errorHandlerMiddleware(
      new ValidationError("content is required"),
      makeReq(),
      res,
      vi.fn(),
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "content is required" });
  });

  test("maps unknown errors to 500 with the message outside production", () => {
    const res = makeRes();

    errorHandlerMiddleware(new Error("boom"), makeReq(), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "boom" });
  });

  test("masks unknown error messages in production", () => {
    process.env.NODE_ENV = "production";
    const res = makeRes();

    errorHandlerMiddleware(
      new Error("internal details"),
      makeReq(),
      res,
      vi.fn(),
    );

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "Server error" });
  });

  test("preserves statusCode-bearing 4xx error messages in production", () => {
    process.env.NODE_ENV = "production";
    const res = makeRes();
    const err = Object.assign(new Error("resource not found"), {
      statusCode: 404,
    });

    errorHandlerMiddleware(err, makeReq(), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: "resource not found" });
  });

  test("masks statusCode-bearing 5xx error messages in production", () => {
    process.env.NODE_ENV = "production";
    const res = makeRes();
    const err = Object.assign(new Error("upstream exploded"), {
      statusCode: 502,
    });

    errorHandlerMiddleware(err, makeReq(), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith({ error: "Server error" });
  });

  test("delegates to next(err) when headers are already sent", () => {
    const res = makeRes(true);
    const next = vi.fn();
    const err = new Error("late failure");

    errorHandlerMiddleware(err, makeReq(), res, next);

    expect(next).toHaveBeenCalledWith(err);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  test("handles non-Error thrown values with a generic 500", () => {
    process.env.NODE_ENV = "production";
    const res = makeRes();

    errorHandlerMiddleware("string error", makeReq(), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "Server error" });
  });
});
