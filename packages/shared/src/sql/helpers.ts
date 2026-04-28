import type {
  SQLBinaryMarker,
  SQLBooleanMarker,
  SQLDateMarker,
  SQLNumberMarker,
  SQLStringMarker,
  SQLTimestampMarker,
  SQLTypeMarker,
} from "./types";

function coerceNumericLike(value: number | string, fnName: string): string {
  if (typeof value === "number") {
    return value.toString();
  }
  if (typeof value === "string") {
    if (value === "" || Number.isNaN(Number(value))) {
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
    if (!Number.isInteger(value)) {
      throw new Error(
        `${fnName}() expects an integer, got non-integer number: ${value}`,
      );
    }
    return value.toString();
  }
  if (typeof value === "string") {
    if (value === "" || !/^-?\d+$/.test(value)) {
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
   * and `OFFSET` (which require integer types):
   *
   * - JS integer (`10`) → `BIGINT`
   * - JS non-integer (`3.14`) → `DOUBLE`
   * - numeric string (`"123.45"`) → `NUMERIC` (preserves caller's precision intent)
   *
   * Reach for `sql.int()`, `sql.bigint()`, `sql.float()`, `sql.double()`, or
   * `sql.decimal()` if you need to override the inferred type.
   *
   * @param value - Number or numeric string
   * @returns Marker for a numeric SQL parameter
   * @example
   * ```typescript
   * const params = { userId: sql.number(123) };       // BIGINT, value "123"
   * const params = { ratio: sql.number(0.5) };        // DOUBLE, value "0.5"
   * const params = { amount: sql.number("123.45") };  // NUMERIC, value "123.45"
   * ```
   */
  number(value: number | string): SQLNumberMarker {
    let numValue: string = "";
    let inferredType: SQLNumberMarker["__sql_type"] = "NUMERIC";

    if (typeof value === "number") {
      numValue = value.toString();
      inferredType = Number.isInteger(value) ? "BIGINT" : "DOUBLE";
    } else if (typeof value === "string") {
      if (value === "" || Number.isNaN(Number(value))) {
        throw new Error(
          `sql.number() expects number or numeric string, got: ${value === "" ? "empty string" : value}`,
        );
      }
      numValue = value;
      // Strings stay NUMERIC: the caller chose to pass a string, so honour
      // their precision intent rather than coercing through JS number.
      inferredType = "NUMERIC";
    } else {
      throw new Error(
        `sql.number() expects number or numeric string, got: ${typeof value}`,
      );
    }

    return {
      __sql_type: inferredType,
      value: numValue,
    };
  },

  /**
   * Creates an `INT` (32-bit signed integer) parameter. Use when the column
   * or context requires `INT` specifically (e.g. legacy schemas, or to make
   * the wire type explicit).
   *
   * @param value - Integer number or integer-shaped string
   */
  int(value: number | string): SQLNumberMarker {
    return {
      __sql_type: "INT",
      value: coerceIntegerLike(value, "sql.int"),
    };
  },

  /**
   * Creates a `BIGINT` (64-bit signed integer) parameter. Accepts JS
   * `bigint` so callers can round-trip values outside `Number.MAX_SAFE_INTEGER`
   * without precision loss.
   *
   * @param value - Integer number, bigint, or integer-shaped string
   */
  bigint(value: number | bigint | string): SQLNumberMarker {
    if (typeof value === "bigint") {
      return { __sql_type: "BIGINT", value: value.toString() };
    }
    return {
      __sql_type: "BIGINT",
      value: coerceIntegerLike(value, "sql.bigint"),
    };
  },

  /**
   * Creates a `FLOAT` (single-precision) parameter.
   *
   * @param value - Number or numeric string
   */
  float(value: number | string): SQLNumberMarker {
    return {
      __sql_type: "FLOAT",
      value: coerceNumericLike(value, "sql.float"),
    };
  },

  /**
   * Creates a `DOUBLE` (double-precision) parameter. Same precision as a JS
   * `number`, so `sql.double(value)` is exact for any JS number.
   *
   * @param value - Number or numeric string
   */
  double(value: number | string): SQLNumberMarker {
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
   * @param value - Number or numeric string (strings preferred for precision)
   */
  decimal(value: number | string): SQLNumberMarker {
    return {
      __sql_type: "NUMERIC",
      value: coerceNumericLike(value, "sql.decimal"),
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
