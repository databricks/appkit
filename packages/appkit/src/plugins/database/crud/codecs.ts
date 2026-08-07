import { DatabasePluginError } from "../../../database/errors";
import type { ScalarValue } from "../../../database/runtime";
import type { ColumnMeta } from "../../../database/schema-builder";
import { columnValueSchema } from "../../../database/schema-builder/validators";

/** JSON-representable value; every generated response is built from these. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Both wire directions for one column, compiled once per exposed table. */
export interface CompiledColumn {
  readonly meta: ColumnMeta;
  /** Untrusted wire value to canonical runtime value; `undefined` when invalid. */
  decode(raw: unknown): ScalarValue | undefined;
  /** Trusted runtime value to its deterministic JSON form. */
  encode(value: unknown): JsonValue;
}

/** Decimal integer with no sign padding, leading zeros, or exponent. */
const DECIMAL_INT = /^-?(0|[1-9]\d*)$/;

/**
 * Map a wire value onto the runtime representation the schema validators and
 * Drizzle columns expect. Only path segments and JSON scalars reach this, so
 * the accepted shapes stay exact rather than coercing whatever parses.
 */
function toRuntimeValue(
  kind: ColumnMeta["kind"],
  raw: unknown,
): ScalarValue | undefined {
  switch (kind) {
    case "number":
      if (typeof raw === "number") return raw;
      return typeof raw === "string" && DECIMAL_INT.test(raw)
        ? Number(raw)
        : undefined;
    case "bigint":
      if (typeof raw === "string" && DECIMAL_INT.test(raw)) return BigInt(raw);
      return typeof raw === "number" && Number.isSafeInteger(raw)
        ? BigInt(raw)
        : undefined;
    case "boolean":
      return typeof raw === "boolean" ? raw : undefined;
    case "string":
    case "uuid":
    case "enum":
    case "date":
      return typeof raw === "string" ? raw : undefined;
    default:
      return undefined;
  }
}

function encodeValue(meta: ColumnMeta, value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  switch (meta.kind) {
    case "bigint":
      // JSON cannot carry a bigint, and a large id must not lose precision.
      if (typeof value === "bigint") return value.toString();
      if (typeof value === "number" && Number.isSafeInteger(value)) {
        return value.toString();
      }
      break;
    case "number":
      if (typeof value === "number" && Number.isFinite(value)) return value;
      break;
    case "boolean":
      if (typeof value === "boolean") return value;
      break;
    case "string":
    case "uuid":
    case "enum":
    case "date":
      if (typeof value === "string") return value;
      break;
    case "json":
      if (isJsonValue(value)) return value;
      break;
    case "unknown":
      break;
  }
  // The driver produced a value this column contract cannot describe.
  throw new DatabasePluginError("INTERNAL", "read");
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return true;
  if (typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Compile the wire codecs for one column from its finalized metadata. */
export function compileColumn(meta: ColumnMeta): CompiledColumn {
  const schema = columnValueSchema(meta);
  return {
    meta,
    decode: (raw) => {
      const candidate = toRuntimeValue(meta.kind, raw);
      if (candidate === undefined) return undefined;
      return schema.safeParse(candidate).success ? candidate : undefined;
    },
    encode: (value) => encodeValue(meta, value),
  };
}
