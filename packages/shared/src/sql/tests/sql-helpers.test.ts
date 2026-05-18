import { describe, expect, it } from "vitest";
import { isSQLTypeMarker, sql } from "../helpers";

describe("SQL Helpers", () => {
  describe("date()", () => {
    it("should create a DATE type parameter from a Date object", () => {
      const date = new Date("2024-01-01");
      const result = sql.date(date);
      expect(result).toEqual({
        __sql_type: "DATE",
        value: "2024-01-01",
      });
    });

    it("should create a DATE type parameter from an ISO date string", () => {
      const date = "2024-01-01";
      const result = sql.date(date);
      expect(result).toEqual({
        __sql_type: "DATE",
        value: "2024-01-01",
      });
    });

    it("should reject invalid date format", () => {
      const date = "01/01/2024";
      expect(() => sql.date(date)).toThrow(
        "sql.date() expects Date or ISO date string (YYYY-MM-DD format), got: 01/01/2024",
      );
    });

    it("should reject invalid date value", () => {
      const date = 1234567890;
      expect(() => sql.date(date as any)).toThrow(
        "sql.date() expects Date or ISO date string (YYYY-MM-DD format), got: number",
      );
    });
  });

  describe("number()", () => {
    it("should bind a JS integer in INT range as INT (works with Spark LIMIT/OFFSET)", () => {
      // Spark requires IntegerType for LIMIT/OFFSET; BIGINT/LongType is
      // rejected with INVALID_LIMIT_LIKE_EXPRESSION.DATA_TYPE. INT is
      // auto-widened to BIGINT/DECIMAL/DOUBLE by Catalyst for wider columns.
      const result = sql.number(1234567890);
      expect(result).toEqual({
        __sql_type: "INT",
        value: "1234567890",
      });
    });

    it("should bind a JS integer outside INT range as BIGINT", () => {
      const result = sql.number(3_000_000_000);
      expect(result).toEqual({
        __sql_type: "BIGINT",
        value: "3000000000",
      });
    });

    it("should bind INT boundaries correctly", () => {
      expect(sql.number(2147483647)).toEqual({
        __sql_type: "INT",
        value: "2147483647",
      });
      expect(sql.number(-2147483648)).toEqual({
        __sql_type: "INT",
        value: "-2147483648",
      });
      // Just past INT_MAX → BIGINT
      expect(sql.number(2147483648)).toEqual({
        __sql_type: "BIGINT",
        value: "2147483648",
      });
      expect(sql.number(-2147483649)).toEqual({
        __sql_type: "BIGINT",
        value: "-2147483649",
      });
    });

    it("should bind a JS non-integer as DOUBLE", () => {
      const result = sql.number(3.14);
      expect(result).toEqual({
        __sql_type: "DOUBLE",
        value: "3.14",
      });
    });

    it("should bind an integer-shaped string in INT range as INT (HTTP-input case)", () => {
      // Express/URLSearchParams return strings; common pattern is
      // sql.number(req.query.n) which must work with Spark LIMIT/OFFSET.
      const result = sql.number("1234567890");
      expect(result).toEqual({
        __sql_type: "INT",
        value: "1234567890",
      });
    });

    it("should bind an integer-shaped string outside INT range as BIGINT", () => {
      const result = sql.number("3000000000");
      expect(result).toEqual({
        __sql_type: "BIGINT",
        value: "3000000000",
      });
    });

    it("should accept BIGINT-boundary integer strings", () => {
      expect(sql.number("9223372036854775807")).toEqual({
        __sql_type: "BIGINT",
        value: "9223372036854775807",
      });
      expect(sql.number("-9223372036854775808")).toEqual({
        __sql_type: "BIGINT",
        value: "-9223372036854775808",
      });
    });

    it("should reject integer strings outside 64-bit signed range", () => {
      // String input bypasses Number.MAX_SAFE_INTEGER guards, but the
      // BIGINT wire type still cannot hold values outside 2^63.
      expect(() => sql.number("9223372036854775808")).toThrow(
        /BIGINT \(64-bit signed\) range/,
      );
      expect(() => sql.number("-9223372036854775809")).toThrow(
        /BIGINT \(64-bit signed\) range/,
      );
    });

    it("should bind decimal-shaped strings as NUMERIC (preserve precision)", () => {
      const result = sql.number("123.4500000000001");
      expect(result).toEqual({
        __sql_type: "NUMERIC",
        value: "123.4500000000001",
      });
    });

    it("should reject JS integers outside Number.MAX_SAFE_INTEGER", () => {
      // 9007199254740993 is MAX_SAFE_INTEGER + 2 and cannot be represented
      // exactly as a JS number. The marker would advertise BIGINT but the
      // value is already wrong before the helper runs.
      expect(() => sql.number(Number.MAX_SAFE_INTEGER + 2)).toThrow(
        /outside Number\.MAX_SAFE_INTEGER/,
      );
    });

    it("should reject Infinity / -Infinity / NaN", () => {
      expect(() => sql.number(Number.POSITIVE_INFINITY)).toThrow(
        /finite number/,
      );
      expect(() => sql.number(Number.NEGATIVE_INFINITY)).toThrow(
        /finite number/,
      );
      expect(() => sql.number(Number.NaN)).toThrow(/finite number/);
    });

    it("should emit canonical decimal text (no exponent) for large safe integers", () => {
      // Sanity check: even though Number.prototype.toString could emit
      // exponent form for very large integers, the helper always emits
      // decimal text via BigInt(value).toString(). 1e15 is outside INT
      // range, so the wire type is BIGINT.
      const result = sql.number(1e15);
      expect(result).toEqual({
        __sql_type: "BIGINT",
        value: "1000000000000000",
      });
    });

    it.each([["NaN"], ["Infinity"], ["0x10"], ["  "], ["hello"]])(
      "should reject non-numeric string %s",
      (input) => {
        expect(() => sql.number(input as any)).toThrow(
          /expects number or numeric string/,
        );
      },
    );

    it("should reject empty string", () => {
      expect(() => sql.number("")).toThrow(
        "sql.number() expects number or numeric string, got: empty string",
      );
    });

    it("should reject boolean value", () => {
      expect(() => sql.number(true as any)).toThrow(
        "sql.number() expects number or numeric string, got: boolean",
      );
    });
  });

  describe("int() / bigint() / float() / double() / numeric()", () => {
    it("sql.int() should produce INT", () => {
      expect(sql.int(42)).toEqual({ __sql_type: "INT", value: "42" });
      expect(sql.int("42")).toEqual({ __sql_type: "INT", value: "42" });
    });

    it("sql.int() should reject non-integers", () => {
      expect(() => sql.int(3.14)).toThrow(
        "sql.int() expects an integer, got non-integer number: 3.14",
      );
      expect(() => sql.int("3.14")).toThrow(
        "sql.int() expects integer number or integer-shaped string, got: 3.14",
      );
    });

    it("sql.int() should reject values outside 32-bit signed range", () => {
      // 2^31 is just outside INT_MAX
      expect(() => sql.int(2147483648)).toThrow(/INT \(32-bit signed\) range/);
      expect(() => sql.int(-2147483649)).toThrow(/INT \(32-bit signed\) range/);
      // string-shaped out-of-range value
      expect(() => sql.int("9999999999999999999")).toThrow(
        /INT \(32-bit signed\) range/,
      );
    });

    it("sql.int() should accept the INT boundaries", () => {
      expect(sql.int(2147483647)).toEqual({
        __sql_type: "INT",
        value: "2147483647",
      });
      expect(sql.int(-2147483648)).toEqual({
        __sql_type: "INT",
        value: "-2147483648",
      });
    });

    it("sql.bigint() should produce BIGINT and accept JS bigint", () => {
      expect(sql.bigint(42)).toEqual({ __sql_type: "BIGINT", value: "42" });
      expect(sql.bigint("9007199254740993")).toEqual({
        __sql_type: "BIGINT",
        value: "9007199254740993",
      });
      expect(sql.bigint(9007199254740993n)).toEqual({
        __sql_type: "BIGINT",
        value: "9007199254740993",
      });
    });

    it("sql.bigint(number) should reject values outside Number.MAX_SAFE_INTEGER", () => {
      expect(() => sql.bigint(Number.MAX_SAFE_INTEGER + 2)).toThrow(
        /outside Number\.MAX_SAFE_INTEGER/,
      );
    });

    it("sql.bigint(bigint) should reject values outside 64-bit signed range", () => {
      expect(() => sql.bigint(2n ** 63n)).toThrow(
        /BIGINT \(64-bit signed\) range/,
      );
      expect(() => sql.bigint(-(2n ** 63n) - 1n)).toThrow(
        /BIGINT \(64-bit signed\) range/,
      );
    });

    it("sql.bigint() should accept the BIGINT boundaries", () => {
      expect(sql.bigint(2n ** 63n - 1n)).toEqual({
        __sql_type: "BIGINT",
        value: "9223372036854775807",
      });
      expect(sql.bigint(-(2n ** 63n))).toEqual({
        __sql_type: "BIGINT",
        value: "-9223372036854775808",
      });
    });

    it("sql.float() should produce FLOAT", () => {
      expect(sql.float(3.14)).toEqual({ __sql_type: "FLOAT", value: "3.14" });
      expect(sql.float("3.14")).toEqual({
        __sql_type: "FLOAT",
        value: "3.14",
      });
    });

    it("sql.float() should reject non-finite and non-numeric inputs", () => {
      expect(() => sql.float(Number.POSITIVE_INFINITY)).toThrow(
        /finite number/,
      );
      expect(() => sql.float("hello" as any)).toThrow(
        /expects number or numeric string/,
      );
    });

    it("sql.double() should produce DOUBLE", () => {
      expect(sql.double(3.14)).toEqual({
        __sql_type: "DOUBLE",
        value: "3.14",
      });
      expect(sql.double("3.14")).toEqual({
        __sql_type: "DOUBLE",
        value: "3.14",
      });
    });

    it("sql.double() should reject non-finite and non-numeric inputs", () => {
      expect(() => sql.double(Number.NaN)).toThrow(/finite number/);
      expect(() => sql.double("0x10" as any)).toThrow(
        /expects number or numeric string/,
      );
    });

    it("sql.numeric() should produce NUMERIC from a string", () => {
      expect(sql.numeric("12345.6789")).toEqual({
        __sql_type: "NUMERIC",
        value: "12345.6789",
      });
    });

    it("sql.numeric(number) is lossy by design — caller is warned via docstring", () => {
      // Regression test: passing a JS number to sql.numeric serialises with
      // JS-double precision. This pins the behaviour the docstring warns
      // about so the precision-loss caveat is visible in the test suite.
      expect(sql.numeric(0.1 + 0.2)).toEqual({
        __sql_type: "NUMERIC",
        value: "0.30000000000000004",
      });
    });

    it("sql.numeric() should reject non-numeric strings", () => {
      expect(() => sql.numeric("hello" as any)).toThrow(
        /expects number or numeric string/,
      );
    });
  });

  describe("string()", () => {
    it("should create a STRING type parameter from a string", () => {
      const string = "Hello, world!";
      const result = sql.string(string);
      expect(result).toEqual({
        __sql_type: "STRING",
        value: "Hello, world!",
      });
    });
    it("should create a STRING type parameter from a number", () => {
      const number = 1234567890;
      const result = sql.string(number);
      expect(result).toEqual({
        __sql_type: "STRING",
        value: "1234567890",
      });
    });
    it("should create a STRING type parameter from a boolean", () => {
      const boolean = true;
      const result = sql.string(boolean);
      expect(result).toEqual({
        __sql_type: "STRING",
        value: "true",
      });
    });
    it("should reject invalid string value", () => {
      const number = null;
      expect(() => sql.string(number as any)).toThrow(
        "sql.string() expects string or number or boolean, got: object",
      );
    });
  });

  describe("boolean()", () => {
    it("should create a BOOLEAN type parameter from a boolean", () => {
      const boolean = true;
      const result = sql.boolean(boolean);
      expect(result).toEqual({
        __sql_type: "BOOLEAN",
        value: "true",
      });
    });

    it("should create a BOOLEAN type parameter from a string", () => {
      const string = "true";
      const result = sql.boolean(string);
      expect(result).toEqual({
        __sql_type: "BOOLEAN",
        value: "true",
      });
    });
    it("should create a BOOLEAN type parameter from a number", () => {
      const number = 1;
      const result = sql.boolean(number);
      expect(result).toEqual({
        __sql_type: "BOOLEAN",
        value: "true",
      });
    });
    it("should reject invalid type  ", () => {
      const rand = null;
      expect(() => sql.boolean(rand as any)).toThrow(
        "sql.boolean() expects boolean or string (true or false) or number (1 or 0), got: object",
      );
    });

    it("should reject invalid number value", () => {
      const number = 7;
      expect(() => sql.boolean(number as any)).toThrow(
        "sql.boolean() expects boolean or string (true or false) or number (1 or 0), got: 7",
      );
    });

    it("should reject invalid string value", () => {
      const string = "hello";
      expect(() => sql.boolean(string as any)).toThrow(
        "sql.boolean() expects boolean or string (true or false) or number (1 or 0), got: hello",
      );
    });
  });

  describe("binary()", () => {
    it("should create a STRING type with hex value from Uint8Array", () => {
      // "Spark" in bytes → hex "537061726B"
      const data = new Uint8Array([0x53, 0x70, 0x61, 0x72, 0x6b]);
      const result = sql.binary(data);
      expect(result).toEqual({
        __sql_type: "STRING",
        value: "537061726B",
      });
    });

    it("should create a STRING type with hex value from ArrayBuffer", () => {
      const buffer = new Uint8Array([0x1a, 0xbf]).buffer;
      const result = sql.binary(buffer);
      expect(result).toEqual({
        __sql_type: "STRING",
        value: "1ABF",
      });
    });

    it("should accept hex string and normalize to uppercase", () => {
      const result = sql.binary("1abf");
      expect(result).toEqual({
        __sql_type: "STRING",
        value: "1ABF",
      });
    });

    it("should accept empty string", () => {
      const result = sql.binary("");
      expect(result).toEqual({
        __sql_type: "STRING",
        value: "",
      });
    });

    it("should accept empty Uint8Array", () => {
      const result = sql.binary(new Uint8Array([]));
      expect(result).toEqual({
        __sql_type: "STRING",
        value: "",
      });
    });

    it("should handle arbitrary bytes including non-UTF8", () => {
      // 0xFF 0xFE are valid hex bytes even if not valid UTF-8
      const bytes = new Uint8Array([0xff, 0xfe]);
      const result = sql.binary(bytes);
      expect(result).toEqual({
        __sql_type: "STRING",
        value: "FFFE",
      });
    });

    it("should reject invalid hex string", () => {
      expect(() => sql.binary("GHIJ")).toThrow(
        "sql.binary() expects Uint8Array, ArrayBuffer, or hex string, got invalid hex: GHIJ",
      );
    });

    it("should reject invalid type", () => {
      expect(() => sql.binary(123 as any)).toThrow(
        "sql.binary() expects Uint8Array, ArrayBuffer, or hex string, got: number",
      );
    });
  });

  describe("timestamp()", () => {
    it("should create a TIMESTAMP type parameter from a Date object", () => {
      const date = new Date("2024-01-01T12:00:00Z");
      const result = sql.timestamp(date);
      expect(result).toEqual({
        __sql_type: "TIMESTAMP",
        value: "2024-01-01T12:00:00Z",
      });
    });

    it("should create a TIMESTAMP type parameter from an ISO timestamp string", () => {
      const timestamp = "2024-01-01T12:00:00Z";
      const result = sql.timestamp(timestamp);
      expect(result).toEqual({
        __sql_type: "TIMESTAMP",
        value: "2024-01-01T12:00:00Z",
      });
    });

    it("should create a TIMESTAMP type parameter from a Unix timestamp number", () => {
      const timestamp = 1704110400000;
      const result = sql.timestamp(timestamp);
      expect(result).toEqual({
        __sql_type: "TIMESTAMP",
        value: "2024-01-01T12:00:00Z",
      });
    });

    it("should reject invalid timestamp string", () => {
      const timestamp = "2024-01-01";
      expect(() => sql.timestamp(timestamp as any)).toThrow(
        "sql.timestamp() expects ISO timestamp string (YYYY-MM-DDTHH:MM:SS.mmmZ or YYYY-MM-DDTHH:MM:SS.mmm+HH:MM), got: 2024-01-01",
      );
    });

    it("should reject invalid timestamp number", () => {
      const timestamp = "2024-01-01";
      expect(() => sql.timestamp(timestamp as any)).toThrow(
        "sql.timestamp() expects ISO timestamp string (YYYY-MM-DDTHH:MM:SS.mmmZ or YYYY-MM-DDTHH:MM:SS.mmm+HH:MM), got: 2024-01-01",
      );
    });

    it("should reject invalid timestamp value", () => {
      const timestamp = null;
      expect(() => sql.timestamp(timestamp as any)).toThrow(
        "sql.timestamp() expects Date, ISO timestamp string, or Unix timestamp number, got: object",
      );
    });
  });
});

describe("SQL Type Marker", () => {
  it("should return true if the value is a SQL type marker", () => {
    const value = {
      __sql_type: "TIMESTAMP",
      value: "2024-01-01T12:00:00Z",
    };
    expect(isSQLTypeMarker(value)).toBe(true);
  });
});
