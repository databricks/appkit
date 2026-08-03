import { describe, expect, it } from "vitest";
import { classifyBlockingFailure } from "../errors";

describe("classifyBlockingFailure", () => {
  describe("deterministic failures", () => {
    it("classifies HTTP 400 as deterministic", () => {
      const error = new Error("Bad request");
      (error as any).status = 400;
      expect(classifyBlockingFailure(error)).toBe("deterministic");
    });

    it("classifies HTTP 404 as deterministic", () => {
      const error = new Error("Not found");
      (error as any).status = 404;
      expect(classifyBlockingFailure(error)).toBe("deterministic");
    });

    it("classifies HTTP 404 from response.status as deterministic", () => {
      const error = new Error("Not found");
      (error as any).response = { status: 404 };
      expect(classifyBlockingFailure(error)).toBe("deterministic");
    });

    it("classifies HTTP 404 from statusCode as deterministic", () => {
      const error = new Error("Not found");
      (error as any).statusCode = 404;
      expect(classifyBlockingFailure(error)).toBe("deterministic");
    });
  });

  describe("environmental failures - auth", () => {
    it("classifies HTTP 401 as environmental", () => {
      const error = new Error("Unauthorized");
      (error as any).status = 401;
      expect(classifyBlockingFailure(error)).toBe("environmental");
    });

    it("classifies HTTP 403 as environmental", () => {
      const error = new Error("Forbidden");
      (error as any).status = 403;
      expect(classifyBlockingFailure(error)).toBe("environmental");
    });
  });

  describe("environmental failures - other HTTP statuses", () => {
    it("classifies HTTP 500 as environmental (not in deterministic set)", () => {
      const error = new Error("Internal server error");
      (error as any).status = 500;
      expect(classifyBlockingFailure(error)).toBe("environmental");
    });

    it("classifies HTTP 502 as environmental (via connectivity)", () => {
      const error = new Error("Bad gateway");
      (error as any).status = 502;
      expect(classifyBlockingFailure(error)).toBe("environmental");
    });

    it("classifies HTTP 503 as environmental (via connectivity)", () => {
      const error = new Error("Service unavailable");
      (error as any).status = 503;
      expect(classifyBlockingFailure(error)).toBe("environmental");
    });

    it("classifies HTTP 504 as environmental (via connectivity)", () => {
      const error = new Error("Gateway timeout");
      (error as any).status = 504;
      expect(classifyBlockingFailure(error)).toBe("environmental");
    });
  });

  describe("environmental failures - connectivity codes", () => {
    it("classifies ECONNREFUSED as environmental", () => {
      const error = new Error("Connection refused");
      (error as any).code = "ECONNREFUSED";
      expect(classifyBlockingFailure(error)).toBe("environmental");
    });

    it("classifies ENOTFOUND as environmental", () => {
      const error = new Error("ENOTFOUND");
      (error as any).code = "ENOTFOUND";
      expect(classifyBlockingFailure(error)).toBe("environmental");
    });

    it("classifies ETIMEDOUT as environmental", () => {
      const error = new Error("Timed out");
      (error as any).code = "ETIMEDOUT";
      expect(classifyBlockingFailure(error)).toBe("environmental");
    });

    it("classifies ECONNRESET as environmental", () => {
      const error = new Error("Connection reset");
      (error as any).code = "ECONNRESET";
      expect(classifyBlockingFailure(error)).toBe("environmental");
    });

    it("classifies UND_ERR_* codes as environmental", () => {
      const error = new Error("undici error");
      (error as any).code = "UND_ERR_ABORTED";
      expect(classifyBlockingFailure(error)).toBe("environmental");
    });
  });

  describe("environmental failures - TLS codes", () => {
    it("classifies CERT_HAS_EXPIRED as environmental", () => {
      const error = new Error("Certificate has expired");
      (error as any).code = "CERT_HAS_EXPIRED";
      expect(classifyBlockingFailure(error)).toBe("environmental");
    });

    it("classifies DEPTH_ZERO_SELF_SIGNED_CERT as environmental", () => {
      const error = new Error("Self signed cert");
      (error as any).code = "DEPTH_ZERO_SELF_SIGNED_CERT";
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
      const causedError = new Error("Not found");
      (causedError as any).status = 404;

      const error = new Error("Outer error");
      (error as any).cause = causedError;

      expect(classifyBlockingFailure(error)).toBe("deterministic");
    });

    it("classifies connectivity code nested under .cause as environmental", () => {
      const causedError = new Error("Connection refused");
      (causedError as any).code = "ECONNREFUSED";

      const error = new Error("Outer error");
      (error as any).cause = causedError;

      expect(classifyBlockingFailure(error)).toBe("environmental");
    });

    it("classifies AggregateError with 404 as deterministic", () => {
      const statusError = new Error("Not found");
      (statusError as any).status = 404;

      const aggregateError = new AggregateError(
        [statusError],
        "Multiple errors",
      );

      expect(classifyBlockingFailure(aggregateError)).toBe("deterministic");
    });
  });

  describe("purity", () => {
    it("returns the same classification when called twice with the same input", () => {
      const error = new Error("Not found");
      (error as any).status = 404;

      const result1 = classifyBlockingFailure(error);
      const result2 = classifyBlockingFailure(error);

      expect(result1).toBe(result2);
      expect(result1).toBe("deterministic");
    });

    it("returns the same classification for equivalent errors", () => {
      const error1 = new Error("Connection refused");
      (error1 as any).code = "ECONNREFUSED";

      const error2 = new Error("Connection refused");
      (error2 as any).code = "ECONNREFUSED";

      expect(classifyBlockingFailure(error1)).toBe(
        classifyBlockingFailure(error2),
      );
      expect(classifyBlockingFailure(error1)).toBe("environmental");
    });
  });
});
