import { ModularApiError } from "shared/workspace-client";
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
