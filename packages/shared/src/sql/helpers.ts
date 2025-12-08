/**
 * Object that identifies a typed SQL parameter.
 * Created using sql.date(), sql.string(), sql.number(), sql.boolean(), sql.timestamp(), sql.binary(), or sql.interval().
 */
export interface SQLTypeMarker {
  __sql_type:
    | "DATE"
    | "TIMESTAMP"
    | "STRING"
    | "NUMERIC"
    | "BOOLEAN"
    | "BINARY";
  value: string;
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
  date(value: Date | string): SQLTypeMarker {
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
  timestamp(value: Date | string | number): SQLTypeMarker {
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
   * Creates a NUMERIC type parameter
   * Accepts numbers or numeric strings
   * @param value - Number or numeric string
   * @returns Marker object for NUMERIC type parameter
   * @example
   * ```typescript
   * const params = { userId: sql.number(123) };
   * params = { userId: "123" }
   * ```
   * @example
   * ```typescript
   * const params = { userId: sql.number("123") };
   * params = { userId: "123" }
   * ```
   */
  number(value: number | string): SQLTypeMarker {
    let numValue: string = "";

    // check if value is a number
    if (typeof value === "number") {
      numValue = value.toString();
    }
    // check if value is a string
    else if (typeof value === "string") {
      if (value === "" || Number.isNaN(Number(value))) {
        throw new Error(
          `sql.number() expects number or numeric string, got: ${value === "" ? "empty string" : value}`,
        );
      }
      numValue = value;
    }
    // if value is not a number or string, throw an error
    else {
      throw new Error(
        `sql.number() expects number or numeric string, got: ${typeof value}`,
      );
    }

    return {
      __sql_type: "NUMERIC",
      value: numValue,
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
  string(value: string | number | boolean): SQLTypeMarker {
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
  boolean(value: boolean | string | number): SQLTypeMarker {
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
  binary(value: Uint8Array | ArrayBuffer | string): SQLTypeMarker {
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
