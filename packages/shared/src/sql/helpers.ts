import type {
  SQLBinaryMarker,
  SQLBooleanMarker,
  SQLDateMarker,
  SQLNumberMarker,
  SQLStringMarker,
  SQLTimestampMarker,
  SQLTypeMarker,
} from "./types";

// Strict numeric-literal regex used by string-input paths. Rejects empty
// strings, whitespace, hex/octal/binary, `NaN`, `Infinity`, and other forms
// that JS `Number()` would silently coerce.
const NUMERIC_LITERAL_RE = /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const INTEGER_LITERAL_RE = /^-?\d+$/;

// 32-bit signed INT range
const INT_MIN = -(2n ** 31n);
const INT_MAX = 2n ** 31n - 1n;
// 64-bit signed BIGINT range
const BIGINT_MIN = -(2n ** 63n);
const BIGINT_MAX = 2n ** 63n - 1n;

function ensureFiniteNumber(value: number, fnName: string): void {
  if (!Number.isFinite(value)) {
    throw new Error(`${fnName}() expects a finite number, got: ${value}`);
  }
}

function ensureSafeInteger(value: number, fnName: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new Error(
      `${fnName}() received an integer outside Number.MAX_SAFE_INTEGER ` +
        `(${value}); JS numbers cannot represent it exactly. ` +
        `Pass a bigint (sql.bigint(BigInt("..."))) or an integer-shaped string instead.`,
    );
  }
}

function ensureInBigIntRange(
  parsed: bigint,
  min: bigint,
  max: bigint,
  typeName: string,
  fnName: string,
  hint: string,
): void {
  if (parsed < min || parsed > max) {
    throw new Error(
      `${fnName}() value ${parsed} is outside ${typeName} range [${min}, ${max}]. ${hint}`,
    );
  }
}

function coerceNumericLike(value: number | string, fnName: string): string {
  if (typeof value === "number") {
    ensureFiniteNumber(value, fnName);
    return value.toString();
  }
  if (typeof value === "string") {
    if (!NUMERIC_LITERAL_RE.test(value)) {
      throw new Error(
        `${fnName}() expects number or numeric string, got: ${value === "" ? "empty string" : value}`,
      );
    }
    return value;
  }
  throw new Error(
    `${fnName}() expects number or numeric string, got: ${typeof value}`,
  );
}

function coerceIntegerLike(value: number | string, fnName: string): string {
  if (typeof value === "number") {
    ensureFiniteNumber(value, fnName);
    if (!Number.isInteger(value)) {
      throw new Error(
        `${fnName}() expects an integer, got non-integer number: ${value}`,
      );
    }
    ensureSafeInteger(value, fnName);
    // BigInt(value).toString() emits canonical decimal-integer text;
    // Number.prototype.toString emits exponent notation for values like 1e21.
    return BigInt(value).toString();
  }
  if (typeof value === "string") {
    if (!INTEGER_LITERAL_RE.test(value)) {
      throw new Error(
        `${fnName}() expects integer number or integer-shaped string, got: ${value === "" ? "empty string" : value}`,
      );
    }
    return value;
  }
  throw new Error(
    `${fnName}() expects integer number or integer-shaped string, got: ${typeof value}`,
  );
}

/**
 * SQL helper namespace
 */
export const sql = {
  /**
   * Creates a DATE type parameter
   * Accepts Date objects or ISO date strings (YYYY-MM-DD format)
   * @param value - Date object or ISO date string
   * @returns Marker object for DATE type parameter
   * @example
   * ```typescript
   * const params = { startDate: sql.date(new Date("2024-01-01")) };
   * params = { startDate: "2024-01-01" }
   * ```
   * @example
   * ```typescript
   * const params = { startDate: sql.date("2024-01-01") };
   * params = { startDate: "2024-01-01" }
   * ```
   */
  date(value: Date | string): SQLDateMarker {
    let dateValue: string = "";

    // check if value is a Date object
    if (value instanceof Date) {
      dateValue = value.toISOString().split("T")[0];
    }
    // check if value is a string
    else if (typeof value === "string") {
      // validate format
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new Error(
          `sql.date() expects Date or ISO date string (YYYY-MM-DD format), got: ${value}`,
        );
      }
      dateValue = value;
    }
    // if value is not a Date object or string, throw an error
    else {
      throw new Error(
        `sql.date() expects Date or ISO date string (YYYY-MM-DD format), got: ${typeof value}`,
      );
    }

    return {
      __sql_type: "DATE",
      value: dateValue,
    };
  },

  /**
   * Creates a TIMESTAMP type parameter
   * Accepts Date objects, ISO timestamp strings, or Unix timestamp numbers
   * @param value - Date object, ISO timestamp string, or Unix timestamp number
   * @returns Marker object for TIMESTAMP type parameter
   * @example
   * ```typescript
   * const params = { createdTime: sql.timestamp(new Date("2024-01-01T12:00:00Z")) };
   * params = { createdTime: "2024-01-01T12:00:00Z" }
   * ```
   * @example
   * ```typescript
   * const params = { createdTime: sql.timestamp("2024-01-01T12:00:00Z") };
   * params = { createdTime: "2024-01-01T12:00:00Z" }
   * ```
   * @example
   * ```typescript
   * const params = { createdTime: sql.timestamp(1704110400000) };
   * params = { createdTime: "2024-01-01T12:00:00Z" }
   * ```
   */
  timestamp(value: Date | string | number): SQLTimestampMarker {
    let timestampValue: string = "";

    if (value instanceof Date) {
      timestampValue = value.toISOString().replace(/\.000(Z|[+-])/, "$1");
    } else if (typeof value === "string") {
      const isoRegex =
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})?$/;
      if (!isoRegex.test(value)) {
        throw new Error(
          `sql.timestamp() expects ISO timestamp string (YYYY-MM-DDTHH:MM:SS.mmmZ or YYYY-MM-DDTHH:MM:SS.mmm+HH:MM), got: ${value}`,
        );
      }
      timestampValue = value;
    } else if (typeof value === "number") {
      const date = new Date(value > 1e12 ? value : value * 1000);
      timestampValue = date.toISOString().replace(/\.000(Z|[+-])/, "$1");
    } else {
      throw new Error(
        `sql.timestamp() expects Date, ISO timestamp string, or Unix timestamp number, got: ${typeof value}`,
      );
    }

    return {
      __sql_type: "TIMESTAMP",
      value: timestampValue,
    };
  },

  /**
   * Creates a numeric type parameter. The wire SQL type is inferred from the
   * value so the parameter binds correctly in any context, including `LIMIT`
   * and `OFFSET`:
   *
   * - JS integer in `[-2^31, 2^31 - 1]` → `INT`
   * - JS integer outside `INT` but within `Number.MAX_SAFE_INTEGER` → `BIGINT`
   * - JS non-integer (`3.14`) → `DOUBLE`
   * - integer-shaped string in `INT` range → `INT` (common HTTP-input case)
   * - integer-shaped string outside `INT` but within `BIGINT` → `BIGINT`
   * - decimal-shaped string (`"123.45"`) → `NUMERIC` (preserves precision)
   *
   * Why default to `INT`? Spark's `LIMIT` and `OFFSET` operators require
   * `IntegerType` specifically — `BIGINT` (`LongType`) is rejected with
   * `INVALID_LIMIT_LIKE_EXPRESSION.DATA_TYPE`. Catalyst auto-widens `INT`
   * to `BIGINT` / `DECIMAL` / `DOUBLE` for wider columns, so `INT` is a
   * strictly better default than `BIGINT`.
   *
   * Throws on `NaN`, `Infinity`, JS integers outside `Number.MAX_SAFE_INTEGER`,
   * integer-shaped strings outside the `BIGINT` range, or non-numeric strings.
   * Reach for `sql.int()`, `sql.bigint()`, `sql.float()`, `sql.double()`, or
   * `sql.numeric()` to override the inferred type.
   *
   * @param value - Number or numeric string
   * @returns Marker for a numeric SQL parameter
   * @example
   * ```typescript
   * sql.number(123);              // { __sql_type: "INT",    value: "123" }
   * sql.number(3_000_000_000);    // { __sql_type: "BIGINT", value: "3000000000" }
   * sql.number(0.5);              // { __sql_type: "DOUBLE", value: "0.5" }
   * sql.number("10");             // { __sql_type: "INT",    value: "10" }
   * sql.number("123.45");         // { __sql_type: "NUMERIC", value: "123.45" }
   * ```
   */
  number(value: number | string): SQLNumberMarker {
    if (typeof value === "number") {
      ensureFiniteNumber(value, "sql.number");
      if (Number.isInteger(value)) {
        ensureSafeInteger(value, "sql.number");
        const asBigInt = BigInt(value);
        // INT (32-bit) is required by Spark for LIMIT/OFFSET; Catalyst
        // widens INT → BIGINT/DECIMAL/DOUBLE automatically.
        if (asBigInt >= INT_MIN && asBigInt <= INT_MAX) {
          return { __sql_type: "INT", value: asBigInt.toString() };
        }
        return { __sql_type: "BIGINT", value: asBigInt.toString() };
      }
      return { __sql_type: "DOUBLE", value: value.toString() };
    }
    if (typeof value === "string") {
      if (!NUMERIC_LITERAL_RE.test(value)) {
        throw new Error(
          `sql.number() expects number or numeric string, got: ${value === "" ? "empty string" : value}`,
        );
      }
      // Integer-shaped strings get the same INT-preferring inference, so
      // `sql.number(req.query.n)` (Express/URLSearchParams strings) works
      // with LIMIT/OFFSET out of the box. Out-of-BIGINT-range throws —
      // sql.numeric() is the right helper for arbitrary-precision integers.
      if (INTEGER_LITERAL_RE.test(value)) {
        const parsed = BigInt(value);
        ensureInBigIntRange(
          parsed,
          BIGINT_MIN,
          BIGINT_MAX,
          "BIGINT (64-bit signed)",
          "sql.number",
          "Use sql.numeric() with a string for arbitrary-precision integers.",
        );
        if (parsed >= INT_MIN && parsed <= INT_MAX) {
          return { __sql_type: "INT", value };
        }
        return { __sql_type: "BIGINT", value };
      }
      // Non-integer strings stay NUMERIC: the caller chose to pass a string,
      // honour their precision intent rather than coercing through JS number.
      return { __sql_type: "NUMERIC", value };
    }
    throw new Error(
      `sql.number() expects number or numeric string, got: ${typeof value}`,
    );
  },

  /**
   * Creates an `INT` (32-bit signed integer) parameter. Use when the column
   * or context requires `INT` specifically (e.g. legacy schemas, or to make
   * the wire type explicit).
   *
   * Rejects non-integers, values outside `Number.MAX_SAFE_INTEGER` (for
   * number inputs), and values outside the signed 32-bit range
   * `[-2^31, 2^31 - 1]`.
   *
   * @param value - Integer number or integer-shaped string
   * @returns Marker pinned to `INT`
   * @example
   * ```typescript
   * sql.int(42);     // { __sql_type: "INT", value: "42" }
   * sql.int("42");   // { __sql_type: "INT", value: "42" }
   * ```
   */
  int(value: number | string): SQLNumberMarker & { __sql_type: "INT" } {
    const stringValue = coerceIntegerLike(value, "sql.int");
    ensureInBigIntRange(
      BigInt(stringValue),
      INT_MIN,
      INT_MAX,
      "INT (32-bit signed)",
      "sql.int",
      "Use sql.bigint() for 64-bit values.",
    );
    return { __sql_type: "INT", value: stringValue };
  },

  /**
   * Creates a `BIGINT` (64-bit signed integer) parameter. Accepts JS
   * `bigint` so callers can round-trip values outside `Number.MAX_SAFE_INTEGER`
   * without precision loss; for `number` inputs, requires
   * `Number.isSafeInteger(value)`.
   *
   * Rejects values outside the signed 64-bit range `[-2^63, 2^63 - 1]`.
   *
   * @param value - Integer number, bigint, or integer-shaped string
   * @returns Marker pinned to `BIGINT`
   * @example
   * ```typescript
   * sql.bigint(42);                     // { __sql_type: "BIGINT", value: "42" }
   * sql.bigint(9007199254740993n);      // { __sql_type: "BIGINT", value: "9007199254740993" }
   * sql.bigint("9007199254740993");     // { __sql_type: "BIGINT", value: "9007199254740993" }
   * ```
   */
  bigint(
    value: number | bigint | string,
  ): SQLNumberMarker & { __sql_type: "BIGINT" } {
    if (typeof value === "bigint") {
      ensureInBigIntRange(
        value,
        BIGINT_MIN,
        BIGINT_MAX,
        "BIGINT (64-bit signed)",
        "sql.bigint",
        "Use sql.numeric() with a string for arbitrary-precision integers.",
      );
      return { __sql_type: "BIGINT", value: value.toString() };
    }
    const stringValue = coerceIntegerLike(value, "sql.bigint");
    ensureInBigIntRange(
      BigInt(stringValue),
      BIGINT_MIN,
      BIGINT_MAX,
      "BIGINT (64-bit signed)",
      "sql.bigint",
      "Use sql.numeric() with a string for arbitrary-precision integers.",
    );
    return { __sql_type: "BIGINT", value: stringValue };
  },

  /**
   * Creates a `FLOAT` (single-precision, 32-bit) parameter. Note that JS
   * numbers are 64-bit doubles, so values may be rounded to fit FLOAT
   * precision at bind time.
   *
   * @param value - Number or numeric string
   * @returns Marker pinned to `FLOAT`
   * @example
   * ```typescript
   * sql.float(3.14);   // { __sql_type: "FLOAT", value: "3.14" }
   * ```
   */
  float(value: number | string): SQLNumberMarker & { __sql_type: "FLOAT" } {
    return {
      __sql_type: "FLOAT",
      value: coerceNumericLike(value, "sql.float"),
    };
  },

  /**
   * Creates a `DOUBLE` (double-precision, 64-bit) parameter. Same precision
   * as a JS `number`, so `sql.double(value)` is exact for any JS number.
   *
   * @param value - Number or numeric string
   * @returns Marker pinned to `DOUBLE`
   * @example
   * ```typescript
   * sql.double(3.14);   // { __sql_type: "DOUBLE", value: "3.14" }
   * ```
   */
  double(value: number | string): SQLNumberMarker & { __sql_type: "DOUBLE" } {
    return {
      __sql_type: "DOUBLE",
      value: coerceNumericLike(value, "sql.double"),
    };
  },

  /**
   * Creates a `NUMERIC` (fixed-point DECIMAL) parameter. Use when you need
   * exact decimal arithmetic (currency, percentages) — pass values as
   * strings to avoid JS-number precision loss.
   *
   * Note: passing a JS `number` is accepted but lossy for many values
   * (e.g. `0.1 + 0.2` → `"0.30000000000000004"`). Prefer strings.
   *
   * @param value - Number or numeric string (strings preferred for precision)
   * @returns Marker pinned to `NUMERIC`
   * @example
   * ```typescript
   * sql.numeric("12345.6789");   // { __sql_type: "NUMERIC", value: "12345.6789" }
   * ```
   */
  numeric(value: number | string): SQLNumberMarker & { __sql_type: "NUMERIC" } {
    return {
      __sql_type: "NUMERIC",
      value: coerceNumericLike(value, "sql.numeric"),
    };
  },

  /**
   * Creates a STRING type parameter
   * Accepts strings, numbers, or booleans
   * @param value - String, number, or boolean
   * @returns Marker object for STRING type parameter
   * @example
   * ```typescript
   * const params = { name: sql.string("John") };
   * params = { name: "John" }
   * ```
   * @example
   * ```typescript
   * const params = { name: sql.string(123) };
   * params = { name: "123" }
   * ```
   * @example
   * ```typescript
   * const params = { name: sql.string(true) };
   * params = { name: "true" }
   * ```
   */
  string(value: string | number | boolean): SQLStringMarker {
    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      throw new Error(
        `sql.string() expects string or number or boolean, got: ${typeof value}`,
      );
    }

    let stringValue: string = "";

    if (typeof value === "string") {
      stringValue = value;
    } else {
      stringValue = value.toString();
    }

    return {
      __sql_type: "STRING",
      value: stringValue,
    };
  },

  /**
   * Create a BOOLEAN type parameter
   * Accepts booleans, strings, or numbers
   * @param value - Boolean, string, or number
   * @returns Marker object for BOOLEAN type parameter
   * @example
   * ```typescript
   * const params = { isActive: sql.boolean(true) };
   * params = { isActive: "true" }
   * ```
   * @example
   * ```typescript
   * const params = { isActive: sql.boolean("true") };
   * params = { isActive: "true" }
   * ```
   * @example
   * ```typescript
   * const params = { isActive: sql.boolean(1) };
   * params = { isActive: "true" }
   * ```
   * @example
   * ```typescript
   * const params = { isActive: sql.boolean("false") };
   * params = { isActive: "false" }
   * ```
   * @example
   * ```typescript
   * const params = { isActive: sql.boolean(0) };
   * params = { isActive: "false" }
   * ```
   * @returns
   */
  boolean(value: boolean | string | number): SQLBooleanMarker {
    if (
      typeof value !== "boolean" &&
      typeof value !== "string" &&
      typeof value !== "number"
    ) {
      throw new Error(
        `sql.boolean() expects boolean or string (true or false) or number (1 or 0), got: ${typeof value}`,
      );
    }

    let booleanValue: string = "";

    if (typeof value === "boolean") {
      booleanValue = value.toString();
    }
    // check if value is a number
    else if (typeof value === "number") {
      if (value !== 1 && value !== 0) {
        throw new Error(
          `sql.boolean() expects boolean or string (true or false) or number (1 or 0), got: ${value}`,
        );
      }
      booleanValue = value === 1 ? "true" : "false";
    }
    // check if value is a string
    else if (typeof value === "string") {
      if (value !== "true" && value !== "false") {
        throw new Error(
          `sql.boolean() expects boolean or string (true or false) or number (1 or 0), got: ${value}`,
        );
      }
      booleanValue = value;
    }

    return {
      __sql_type: "BOOLEAN",
      value: booleanValue,
    };
  },

  /**
   * Creates a BINARY parameter as hex-encoded STRING
   * Accepts Uint8Array, ArrayBuffer, or hex string
   * Note: Databricks SQL Warehouse doesn't support BINARY as parameter type,
   * so this helper returns a STRING with hex encoding. Use UNHEX(:param) in your SQL.
   * @param value - Uint8Array, ArrayBuffer, or hex string
   * @returns Marker object with STRING type and hex-encoded value
   * @example
   * ```typescript
   * // From Uint8Array:
   * const params = { data: sql.binary(new Uint8Array([0x53, 0x70, 0x61, 0x72, 0x6b])) };
   * // Returns: { __sql_type: "STRING", value: "537061726B" }
   * // SQL: SELECT UNHEX(:data) as binary_value
   * ```
   * @example
   * ```typescript
   * // From hex string:
   * const params = { data: sql.binary("537061726B") };
   * // Returns: { __sql_type: "STRING", value: "537061726B" }
   * ```
   */
  binary(value: Uint8Array | ArrayBuffer | string): SQLBinaryMarker {
    let hexValue: string = "";

    if (value instanceof Uint8Array) {
      // if value is a Uint8Array, convert it to a hex string
      hexValue = Array.from(value)
        .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
        .join("");
    } else if (value instanceof ArrayBuffer) {
      // if value is an ArrayBuffer, convert it to a hex string
      hexValue = Array.from(new Uint8Array(value))
        .map((b) => b.toString(16).padStart(2, "0").toUpperCase())
        .join("");
    } else if (typeof value === "string") {
      // validate hex string
      if (!/^[0-9A-Fa-f]*$/.test(value)) {
        throw new Error(
          `sql.binary() expects Uint8Array, ArrayBuffer, or hex string, got invalid hex: ${value}`,
        );
      }
      hexValue = value.toUpperCase();
    } else {
      throw new Error(
        `sql.binary() expects Uint8Array, ArrayBuffer, or hex string, got: ${typeof value}`,
      );
    }

    return {
      __sql_type: "STRING",
      value: hexValue,
    };
  },
};

/**
 * Type guard to check if a value is a SQL type marker
 * @param value - Value to check
 * @returns True if the value is a SQL type marker, false otherwise
 * @example
 * ```typescript
 * const value = {
 *   __sql_type: "DATE",
 *   value: "2024-01-01",
 * };
 * const isSQLTypeMarker = isSQLTypeMarker(value);
 * console.log(isSQLTypeMarker); // true
 * ```
 */
export function isSQLTypeMarker(value: any): value is SQLTypeMarker {
  return (
    value !== null &&
    typeof value === "object" &&
    "__sql_type" in value &&
    "value" in value &&
    typeof value.__sql_type === "string" &&
    typeof value.value === "string"
  );
}
