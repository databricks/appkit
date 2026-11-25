import { ApiError, ModularApiError } from "shared/workspace-client";
import { describe, expect, test } from "vitest";

import { httpStatusOf } from "../http-status";
import { isUnauthorized } from "../identity-expired";

/** What a typed modular SDK call throws: the status lives in `httpStatusCode`. */
function modularError(status: number) {
  const body = new TextEncoder().encode(
    JSON.stringify({ error_code: "X", message: `status ${status}` }),
  );
  const error = ModularApiError.fromHttpError(status, undefined, body);
  if (!error) throw new Error(`no ApiError for ${status}`);
  return error;
}

describe("modular SDK errors", () => {
  test("carry the status in httpStatusCode, mirrored as the legacy statusCode", () => {
    const error = modularError(401);
    expect(error.httpStatusCode).toBe(401);
    expect((error as unknown as { statusCode: number }).statusCode).toBe(401);
  });

  test("isUnauthorized recognizes a modular 401, directly and as a cause", () => {
    expect(isUnauthorized(modularError(401))).toBe(true);
    expect(
      isUnauthorized(new Error("wrapped", { cause: modularError(401) })),
    ).toBe(true);
    expect(isUnauthorized(modularError(403))).toBe(false);
  });

  test("isUnauthorized recognizes Databricks' 403 for an invalid token", () => {
    const fromBody = (status: number, body: string) => {
      const error = ModularApiError.fromHttpError(
        status,
        undefined,
        new TextEncoder().encode(body),
      );
      if (!error) throw new Error(`no ApiError for ${status}`);
      return error;
    };
    // Expired, revoked, or malformed PAT (numeric error_code, so code is UNKNOWN).
    const pat = fromBody(
      403,
      '{"error_code":403,"message":"Invalid access token. [ReqId: 438fc878]"}',
    );
    // Expired OAuth token: plain-text body, so sdk-core leaves message empty.
    const oauth = fromBody(403, "Invalid Token");
    expect(oauth.message).toBe("");
    expect(isUnauthorized(pat)).toBe(true);
    expect(isUnauthorized(new Error("wrapped", { cause: pat }))).toBe(true);
    expect(isUnauthorized(oauth)).toBe(true);
    // The raw-request seam's wrapper for the same OAuth response.
    expect(
      isUnauthorized(
        new ApiError(
          "Response from server (Forbidden) Invalid Token",
          "Forbidden",
          403,
          "Invalid Token",
        ),
      ),
    ).toBe(true);

    // Authorization failures and a tampered JWT (400) keep their behavior.
    expect(
      isUnauthorized(
        fromBody(
          403,
          '{"error_code":"PERMISSION_DENIED","message":"User does not have USE CATALOG on Catalog \'main\'."}',
        ),
      ),
    ).toBe(false);
    expect(isUnauthorized(fromBody(400, "Invalid Token"))).toBe(false);
  });

  test("httpStatusOf reads statusCode or httpStatusCode", () => {
    expect(httpStatusOf(modularError(404))).toBe(404);
    expect(
      httpStatusOf(Object.assign(new Error("x"), { statusCode: 403 })),
    ).toBe(403);
  });

  test("httpStatusOf ignores non-HTTP values", () => {
    expect(
      httpStatusOf(Object.assign(new Error("x"), { httpStatusCode: -1 })),
    ).toBeUndefined();
    expect(httpStatusOf({ statusCode: 404 })).toBeUndefined();
    expect(httpStatusOf(new Error("plain"))).toBeUndefined();
  });
});
