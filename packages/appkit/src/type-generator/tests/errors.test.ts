import { describe, expect, it } from "vitest";

import {
  classifyBlockingFailure,
  classifyEnvironmentalCause,
  isAuthError,
} from "../errors";

describe("classifyBlockingFailure", () => {
  describe("deterministic failures", () => {
    it("classifies HTTP 400 as deterministic", () => {
      const error = Object.assign(new Error("Bad request"), { status: 400 });
      expect(classifyBlockingFailure(error)).toBe("deterministic");
    });

    it("classifies HTTP 404 as deterministic", () => {
      const error = Object.assign(new Error("Not found"), { status: 404 });
      expect(classifyBlockingFailure(error)).toBe("deterministic");
    });

    it("classifies HTTP 404 from response.status as deterministic", () => {
      const error = Object.assign(new Error("Not found"), {
        response: { status: 404 },
      });
      expect(classifyBlockingFailure(error)).toBe("deterministic");
    });

    it("classifies HTTP 404 from statusCode as deterministic", () => {
      const error = Object.assign(new Error("Not found"), { statusCode: 404 });
      expect(classifyBlockingFailure(error)).toBe("deterministic");
    });
  });

  describe("environmental failures - auth", () => {
    it("classifies HTTP 401 as environmental", () => {
      const error = Object.assign(new Error("Unauthorized"), { status: 401 });
      expect(classifyBlockingFailure(error)).toBe("environmental");
    });

    it("classifies HTTP 403 as environmental", () => {
      const error = Object.assign(new Error("Forbidden"), { status: 403 });
      expect(classifyBlockingFailure(error)).toBe("environmental");
    });
  });

  describe("environmental failures - other HTTP statuses", () => {
    it("classifies HTTP 500 as environmental (not in deterministic set)", () => {
      const error = Object.assign(new Error("Internal server error"), {
        status: 500,
      });
      expect(classifyBlockingFailure(error)).toBe("environmental");
    });

    it("classifies HTTP 502 as environmental (via connectivity)", () => {
      const error = Object.assign(new Error("Bad gateway"), { status: 502 });
      expect(classifyBlockingFailure(error)).toBe("environmental");
    });

    it("classifies HTTP 503 as environmental (via connectivity)", () => {
      const error = Object.assign(new Error("Service unavailable"), {
        status: 503,
      });
      expect(classifyBlockingFailure(error)).toBe("environmental");
    });

    it("classifies HTTP 504 as environmental (via connectivity)", () => {
      const error = Object.assign(new Error("Gateway timeout"), {
        status: 504,
      });
      expect(classifyBlockingFailure(error)).toBe("environmental");
    });
  });

  describe("environmental failures - connectivity codes", () => {
    it("classifies ECONNREFUSED as environmental", () => {
      const error = Object.assign(new Error("Connection refused"), {
        code: "ECONNREFUSED",
      });
      expect(classifyBlockingFailure(error)).toBe("environmental");
    });

    it("classifies ENOTFOUND as environmental", () => {
      const error = Object.assign(new Error("ENOTFOUND"), {
        code: "ENOTFOUND",
      });
      expect(classifyBlockingFailure(error)).toBe("environmental");
    });

    it("classifies ETIMEDOUT as environmental", () => {
      const error = Object.assign(new Error("Timed out"), {
        code: "ETIMEDOUT",
      });
      expect(classifyBlockingFailure(error)).toBe("environmental");
    });

    it("classifies ECONNRESET as environmental", () => {
      const error = Object.assign(new Error("Connection reset"), {
        code: "ECONNRESET",
      });
      expect(classifyBlockingFailure(error)).toBe("environmental");
    });

    it("classifies UND_ERR_* codes as environmental", () => {
      const error = Object.assign(new Error("undici error"), {
        code: "UND_ERR_ABORTED",
      });
      expect(classifyBlockingFailure(error)).toBe("environmental");
    });
  });

  describe("environmental failures - TLS codes", () => {
    it("classifies CERT_HAS_EXPIRED as environmental", () => {
      const error = Object.assign(new Error("Certificate has expired"), {
        code: "CERT_HAS_EXPIRED",
      });
      expect(classifyBlockingFailure(error)).toBe("environmental");
    });

    it("classifies DEPTH_ZERO_SELF_SIGNED_CERT as environmental", () => {
      const error = Object.assign(new Error("Self signed cert"), {
        code: "DEPTH_ZERO_SELF_SIGNED_CERT",
      });
      expect(classifyBlockingFailure(error)).toBe("environmental");
    });
  });

  describe("environmental failures - connectivity messages", () => {
    it("classifies connection refused message as environmental", () => {
      const error = new Error("connection refused");
      expect(classifyBlockingFailure(error)).toBe("environmental");
    });

    it("classifies socket hang up message as environmental", () => {
      const error = new Error("socket hang up");
      expect(classifyBlockingFailure(error)).toBe("environmental");
    });

    it("classifies network error message as environmental", () => {
      const error = new Error("network error");
      expect(classifyBlockingFailure(error)).toBe("environmental");
    });

    it("classifies certificate has expired message as environmental", () => {
      const error = new Error("certificate has expired");
      expect(classifyBlockingFailure(error)).toBe("environmental");
    });
  });

  describe("environmental failures - warehouse state messages", () => {
    it("classifies DELETED warehouse error as environmental", () => {
      const error = new Error("warehouse has been DELETED");
      expect(classifyBlockingFailure(error)).toBe("environmental");
    });

    it("classifies DELETING warehouse error as environmental", () => {
      const error = new Error("warehouse is DELETING");
      expect(classifyBlockingFailure(error)).toBe("environmental");
    });
  });

  describe("environmental failures - timeout messages", () => {
    it("classifies wait-for-RUNNING timeout as environmental", () => {
      const error = new Error(
        "warehouse did not reach RUNNING within 300000ms",
      );
      expect(classifyBlockingFailure(error)).toBe("environmental");
    });
  });

  describe("environmental failures - unrecognized errors", () => {
    it("classifies plain Error with no status as environmental (default)", () => {
      const error = new Error("boom");
      expect(classifyBlockingFailure(error)).toBe("environmental");
    });

    it("classifies plain object error as environmental", () => {
      const error = { message: "something went wrong" };
      expect(classifyBlockingFailure(error)).toBe("environmental");
    });

    it("classifies null as environmental", () => {
      expect(classifyBlockingFailure(null)).toBe("environmental");
    });

    it("classifies undefined as environmental", () => {
      expect(classifyBlockingFailure(undefined)).toBe("environmental");
    });
  });

  describe("wrapped errors", () => {
    it("classifies deterministic status (404) nested under .cause as deterministic", () => {
      const causedError = Object.assign(new Error("Not found"), {
        status: 404,
      });
      const error = Object.assign(new Error("Outer error"), {
        cause: causedError,
      });
      expect(classifyBlockingFailure(error)).toBe("deterministic");
    });

    it("classifies connectivity code nested under .cause as environmental", () => {
      const causedError = Object.assign(new Error("Connection refused"), {
        code: "ECONNREFUSED",
      });
      const error = Object.assign(new Error("Outer error"), {
        cause: causedError,
      });
      expect(classifyBlockingFailure(error)).toBe("environmental");
    });

    it("classifies AggregateError with 404 as deterministic", () => {
      const statusError = Object.assign(new Error("Not found"), {
        status: 404,
      });
      const aggregateError = new AggregateError(
        [statusError],
        "Multiple errors",
      );
      expect(classifyBlockingFailure(aggregateError)).toBe("deterministic");
    });
  });

  describe("purity", () => {
    it("returns the same classification when called twice with the same input", () => {
      const error = Object.assign(new Error("Not found"), { status: 404 });

      const result1 = classifyBlockingFailure(error);
      const result2 = classifyBlockingFailure(error);

      expect(result1).toBe(result2);
      expect(result1).toBe("deterministic");
    });

    it("returns the same classification for equivalent errors", () => {
      const error1 = Object.assign(new Error("Connection refused"), {
        code: "ECONNREFUSED",
      });
      const error2 = Object.assign(new Error("Connection refused"), {
        code: "ECONNREFUSED",
      });

      expect(classifyBlockingFailure(error1)).toBe(
        classifyBlockingFailure(error2),
      );
      expect(classifyBlockingFailure(error1)).toBe("environmental");
    });
  });
});

describe("classifyEnvironmentalCause", () => {
  it("labels connectivity failures as unreachable", () => {
    const error = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    expect(classifyEnvironmentalCause(error)).toBe("unreachable");
  });

  it.each([401, 403])("labels HTTP %i as auth", (status) => {
    const error = Object.assign(new Error("Denied"), { status });
    expect(classifyEnvironmentalCause(error)).toBe("auth");
  });

  it("labels auth status carried on statusCode", () => {
    const error = Object.assign(new Error("Denied"), { statusCode: 403 });
    expect(classifyEnvironmentalCause(error)).toBe("auth");
  });

  it("labels auth status carried on response.status", () => {
    const error = Object.assign(new Error("Denied"), {
      response: { status: 401 },
    });
    expect(classifyEnvironmentalCause(error)).toBe("auth");
  });

  it("labels an auth status wrapped in a cause chain", () => {
    const error = new Error("Request failed", {
      cause: Object.assign(new Error("Denied"), { status: 403 }),
    });
    expect(classifyEnvironmentalCause(error)).toBe("auth");
  });

  it("prefers unreachable when a failure is both connectivity and status-bearing", () => {
    // 503 is connectivity; the label should describe the transport problem.
    const error = Object.assign(new Error("Service unavailable"), {
      status: 503,
    });
    expect(classifyEnvironmentalCause(error)).toBe("unreachable");
  });

  it.each([
    ["a warehouse state message", new Error("warehouse wh-1 is DELETED")],
    ["a plain error", new Error("something went wrong")],
    ["a non-auth status", Object.assign(new Error("teapot"), { status: 418 })],
    ["a non-object", "just a string"],
  ])("labels %s as unavailable", (_name, error) => {
    expect(classifyEnvironmentalCause(error)).toBe("unavailable");
  });

  it("labels a PERMISSION_DENIED error_code (no status) as auth", () => {
    const error = Object.assign(new Error("2f1a9c…"), {
      error_code: "PERMISSION_DENIED",
    });
    expect(classifyEnvironmentalCause(error)).toBe("auth");
  });
});

describe("isAuthError", () => {
  it.each([401, 403])("detects HTTP %i", (status) => {
    expect(isAuthError(Object.assign(new Error("Denied"), { status }))).toBe(
      true,
    );
  });

  it("detects a PERMISSION_DENIED error_code carried with no numeric status", () => {
    // The shape observed on deploy: an error_code string, no HTTP status.
    const error = Object.assign(new Error("2f1a9c…"), {
      error_code: "PERMISSION_DENIED",
    });
    expect(isAuthError(error)).toBe(true);
  });

  it("detects UNAUTHENTICATED via error_code", () => {
    const error = Object.assign(new Error("no token"), {
      error_code: "UNAUTHENTICATED",
    });
    expect(isAuthError(error)).toBe(true);
  });

  it("detects error_code embedded as a JSON body in the message", () => {
    const error = new Error(
      'Response from server (Forbidden) {"error_code":"PERMISSION_DENIED","message":"nope"}',
    );
    expect(isAuthError(error)).toBe(true);
  });

  it("detects an auth status wrapped in a cause chain", () => {
    const error = new Error("Request failed", {
      cause: Object.assign(new Error("Denied"), { status: 403 }),
    });
    expect(isAuthError(error)).toBe(true);
  });

  it.each([
    ["a bad-id 404", Object.assign(new Error("Not found"), { status: 404 })],
    ["a 400", Object.assign(new Error("Bad request"), { status: 400 })],
    [
      "a connectivity code",
      Object.assign(new Error("x"), { code: "ECONNREFUSED" }),
    ],
    [
      "a non-auth error_code",
      Object.assign(new Error("x"), { error_code: "TABLE_OR_VIEW_NOT_FOUND" }),
    ],
    ["a plain error", new Error("boom")],
    ["a non-object", "just a string"],
  ])("returns false for %s", (_name, error) => {
    expect(isAuthError(error)).toBe(false);
  });
});
