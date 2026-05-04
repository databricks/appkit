import { describe, expect, test } from "vitest";
import {
  MAX_REQUEST_ID_LENGTH,
  REQUEST_ID_HEADERS,
  REQUEST_ID_PATTERN,
  resolveRequestId,
  sanitizeRequestId,
} from "../request-id";

/**
 * Build a minimal stand-in for an Express Request that exposes the
 * `header(name)` accessor `resolveRequestId` consults. Header lookup is
 * case-insensitive (matching Express semantics) so callers can pass
 * either canonical lowercase or arbitrary casing.
 */
function makeReq(headers: Record<string, string | undefined>) {
  const lower: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(headers)) {
    lower[k.toLowerCase()] = v;
  }
  return {
    header(name: string): string | undefined {
      return lower[name.toLowerCase()];
    },
  };
}

describe("sanitizeRequestId", () => {
  test("accepts simple alphanumeric IDs", () => {
    expect(sanitizeRequestId("abc123")).toBe("abc123");
  });

  test("accepts IDs with internal hyphens, underscores, and dots", () => {
    expect(sanitizeRequestId("trace.abc-123_xyz")).toBe("trace.abc-123_xyz");
  });

  test("accepts IDs at the maximum length", () => {
    const id = "a".repeat(MAX_REQUEST_ID_LENGTH);
    expect(sanitizeRequestId(id)).toBe(id);
  });

  test("rejects IDs over the maximum length", () => {
    expect(sanitizeRequestId("a".repeat(MAX_REQUEST_ID_LENGTH + 1))).toBe(
      undefined,
    );
  });

  test("rejects IDs starting with a dash (potential shell-flag confusion)", () => {
    expect(sanitizeRequestId("-rf")).toBe(undefined);
    expect(sanitizeRequestId("--help")).toBe(undefined);
  });

  test("rejects IDs starting with an underscore", () => {
    expect(sanitizeRequestId("_internal")).toBe(undefined);
  });

  test("rejects IDs starting with a dot", () => {
    expect(sanitizeRequestId(".bad")).toBe(undefined);
  });

  test("rejects empty string", () => {
    expect(sanitizeRequestId("")).toBe(undefined);
  });

  test("rejects values with characters outside the allowlist", () => {
    expect(sanitizeRequestId("abc def")).toBe(undefined); // space
    expect(sanitizeRequestId("abc/def")).toBe(undefined); // slash
    expect(sanitizeRequestId("abc:def")).toBe(undefined); // colon
  });

  test("rejects CRLF-injection attempts (CWE-117)", () => {
    expect(sanitizeRequestId("attacker\r\nSet-Cookie: pwn=1")).toBe(undefined);
    expect(sanitizeRequestId("a\nb")).toBe(undefined);
    expect(sanitizeRequestId("a\rb")).toBe(undefined);
  });

  test("REQUEST_ID_PATTERN is exported and matches sanitizeRequestId", () => {
    expect(REQUEST_ID_PATTERN.test("abc123")).toBe(true);
    expect(REQUEST_ID_PATTERN.test(".bad")).toBe(false);
    expect(REQUEST_ID_PATTERN.test("a".repeat(MAX_REQUEST_ID_LENGTH + 1))).toBe(
      false,
    );
  });
});

describe("resolveRequestId", () => {
  test("REQUEST_ID_HEADERS lists the canonical header order", () => {
    // The order is load-bearing: it must match the wide-event logger's
    // historical lookup so a single request produces one request_id
    // across both the canonical 4xx response and the wide-event log.
    expect(REQUEST_ID_HEADERS).toEqual([
      "x-request-id",
      "x-correlation-id",
      "x-amzn-trace-id",
    ]);
  });

  test("returns sanitized x-request-id when present", () => {
    const id = resolveRequestId(makeReq({ "x-request-id": "abc-123" }));
    expect(id).toBe("abc-123");
  });

  test("falls back to x-correlation-id when x-request-id is absent", () => {
    const id = resolveRequestId(makeReq({ "x-correlation-id": "corr-1" }));
    expect(id).toBe("corr-1");
  });

  test("falls back to x-amzn-trace-id when earlier headers are absent", () => {
    const id = resolveRequestId(
      makeReq({ "x-amzn-trace-id": "Root.1-abc-def" }),
    );
    expect(id).toBe("Root.1-abc-def");
  });

  test("prefers x-request-id over later candidate headers", () => {
    const id = resolveRequestId(
      makeReq({
        "x-request-id": "primary-id",
        "x-correlation-id": "secondary-id",
        "x-amzn-trace-id": "tertiary-id",
      }),
    );
    expect(id).toBe("primary-id");
  });

  test("skips a malformed earlier header and uses a valid later one", () => {
    const id = resolveRequestId(
      makeReq({
        "x-request-id": "-bad",
        "x-correlation-id": "fallback-ok",
      }),
    );
    expect(id).toBe("fallback-ok");
  });

  test("generates a fallback when no candidate headers are present", () => {
    const id = resolveRequestId(makeReq({}));
    expect(id).toMatch(/^req_[a-f0-9]{16}$/);
  });

  test("generates a fallback when all candidate headers are malformed", () => {
    const id = resolveRequestId(
      makeReq({
        "x-request-id": "-bad",
        "x-correlation-id": ".also-bad",
        "x-amzn-trace-id": "_nope",
      }),
    );
    expect(id).toMatch(/^req_[a-f0-9]{16}$/);
  });

  test("ignores empty header values", () => {
    const id = resolveRequestId(
      makeReq({
        "x-request-id": "",
        "x-correlation-id": "fallback-ok",
      }),
    );
    expect(id).toBe("fallback-ok");
  });

  // The wide-event logger and the body-validation wrapper both call
  // `resolveRequestId(req)` independently on the same request. When no
  // valid correlation header is present the fallback used to be
  // generated fresh on each call, producing two different IDs and
  // breaking log/response correlation. The resolver memoizes per
  // request object so all callers see the same value.
  describe("memoization", () => {
    test("returns the same fallback ID across repeated calls on one request", () => {
      const req = makeReq({});
      const a = resolveRequestId(req);
      const b = resolveRequestId(req);
      const c = resolveRequestId(req);
      expect(a).toMatch(/^req_[a-f0-9]{16}$/);
      expect(b).toBe(a);
      expect(c).toBe(a);
    });

    test("returns the same header-derived ID across repeated calls", () => {
      const req = makeReq({ "x-request-id": "abc-123" });
      expect(resolveRequestId(req)).toBe("abc-123");
      expect(resolveRequestId(req)).toBe("abc-123");
    });

    test("different request objects get different fallback IDs", () => {
      const r1 = makeReq({});
      const r2 = makeReq({});
      const id1 = resolveRequestId(r1);
      const id2 = resolveRequestId(r2);
      expect(id1).toMatch(/^req_[a-f0-9]{16}$/);
      expect(id2).toMatch(/^req_[a-f0-9]{16}$/);
      // Two independent requests with no correlation headers must be
      // distinguishable in logs — the fallback is per-request, not
      // process-global.
      expect(id1).not.toBe(id2);
    });
  });

  // AWS X-Ray traffic carries `X-Amzn-Trace-Id: Root=1-...;Parent=...;
  // Sampled=1`. The strict allowlist rejects `=` and `;`, so without a
  // pre-parser the x-amzn-trace-id consultation never triggers in
  // production AWS deployments. The resolver special-cases
  // x-amzn-trace-id to extract the `Root=` segment before sanitizing.
  describe("AWS X-Ray Root= parsing", () => {
    test("extracts Root segment from full AWS X-Ray header", () => {
      const id = resolveRequestId(
        makeReq({
          "x-amzn-trace-id":
            "Root=1-5759e988-bd862e3fe1be46a994272793;Parent=53995c3f42cd8ad8;Sampled=1",
        }),
      );
      expect(id).toBe("1-5759e988-bd862e3fe1be46a994272793");
    });

    test("extracts Root segment when it is not the first part", () => {
      const id = resolveRequestId(
        makeReq({
          "x-amzn-trace-id":
            "Sampled=1;Root=1-5759e988-bd862e3fe1be46a994272793;Parent=53995c3f42cd8ad8",
        }),
      );
      expect(id).toBe("1-5759e988-bd862e3fe1be46a994272793");
    });

    test("falls back to fresh ID when Root= segment is missing", () => {
      // Header is non-empty but has no Root= segment — the parser
      // returns undefined, the raw value still fails the allowlist
      // (contains `=`), so the resolver falls through to a generated
      // ID.
      const id = resolveRequestId(
        makeReq({ "x-amzn-trace-id": "Parent=abc;Sampled=1" }),
      );
      expect(id).toMatch(/^req_[a-f0-9]{16}$/);
    });

    test("falls back when Root= segment value fails the allowlist", () => {
      // A Root segment containing a disallowed character (e.g. space)
      // is rejected by sanitizeRequestId, not silently accepted.
      const id = resolveRequestId(
        makeReq({ "x-amzn-trace-id": "Root=has space;Parent=x" }),
      );
      expect(id).toMatch(/^req_[a-f0-9]{16}$/);
    });

    test("only x-amzn-trace-id triggers Root= parsing", () => {
      // The x-request-id and x-correlation-id headers do not carry
      // X-Ray syntax and must not be mangled by the parser.
      const id = resolveRequestId(
        makeReq({ "x-request-id": "Root=should-not-be-extracted" }),
      );
      // Raw value contains `=` which the allowlist rejects, so the
      // resolver must NOT silently accept "should-not-be-extracted"
      // as if Root= parsing applied here.
      expect(id).toMatch(/^req_[a-f0-9]{16}$/);
    });
  });
});
