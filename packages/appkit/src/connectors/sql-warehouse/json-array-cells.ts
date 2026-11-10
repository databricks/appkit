import { type DataType, Type } from "apache-arrow";

/**
 * How one scalar type is written in an `INLINE` + `JSON_ARRAY` cell. `parse`
 * returns what `vectorFromArray` accepts: an unscaled `bigint` for DECIMAL,
 * epoch milliseconds for DATE and TIMESTAMP.
 */
interface CellCodec {
  /** Defaults to `String(value)`, or base64 for bytes. */
  format?(value: unknown, type: DataType): string;
  parse(cell: string, type: DataType): unknown;
}

const DECIMAL_TEXT = /^(-?)(\d+)(?:\.(\d+))?$/;
const FLOAT_TEXT =
  /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$|^(?:NaN|-?Infinity)$/;
const BASE64_TEXT = /^[A-Za-z0-9+/]*={0,2}$/;
const DATE_TEXT = /^\d{4}-\d{2}-\d{2}$/;
/** `TIMESTAMP` cells carry the session offset (or `Z`); `TIMESTAMP_NTZ` cells carry none. */
const ZONED_TIMESTAMP_TEXT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const LOCAL_TIMESTAMP_TEXT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

function invalid(kind: string, cell: string): Error {
  return new Error(`Invalid ${kind} "${cell}"`);
}

/** `Date.parse` rolls 2026-02-31 over to March, so the day must survive a round trip. */
function epochMillis(text: string, kind: string, cell: string): number {
  const day = cell.slice(0, 10);
  const ms = Date.parse(text);
  const dayMs = Date.parse(`${day}T00:00:00Z`);
  if (
    Number.isNaN(ms) ||
    Number.isNaN(dayMs) ||
    !new Date(dayMs).toISOString().startsWith(day)
  ) {
    throw invalid(kind, cell);
  }
  return ms;
}

const hasTimezone = (type: DataType) =>
  (type as DataType & { timezone?: string | null }).timezone != null;

const CODECS: Partial<Record<Type, CellCodec>> = {
  [Type.Int]: {
    parse(cell, type) {
      const { bitWidth } = type as DataType & { bitWidth: number };
      if (bitWidth === 64) {
        let n: bigint;
        try {
          n = BigInt(cell);
        } catch {
          throw invalid("integer", cell);
        }
        if (String(n) !== cell) throw invalid("integer", cell);
        return n;
      }
      const n = Number(cell);
      const limit = 2 ** (bitWidth - 1);
      if (
        String(n) !== cell ||
        !Number.isInteger(n) ||
        n < -limit ||
        n >= limit
      ) {
        throw invalid("integer", cell);
      }
      return n;
    },
  },
  [Type.Float]: {
    parse(cell) {
      if (!FLOAT_TEXT.test(cell)) throw invalid("number", cell);
      return Number(cell);
    },
  },
  [Type.Decimal]: {
    format(value, type) {
      const { scale } = type as DataType & { scale: number };
      const unscaled = String(value);
      if (scale <= 0) return unscaled;
      const negative = unscaled.startsWith("-");
      let digits = negative ? unscaled.slice(1) : unscaled;
      if (digits.length <= scale) digits = digits.padStart(scale + 1, "0");
      const point = digits.length - scale;
      const out = `${digits.slice(0, point)}.${digits.slice(point)}`;
      return negative ? `-${out}` : out;
    },
    parse(cell, type) {
      const { scale, precision } = type as DataType & {
        scale: number;
        precision: number;
      };
      const match = DECIMAL_TEXT.exec(cell);
      if (!match) throw invalid("decimal", cell);
      const [, sign, whole, fraction = ""] = match;
      const digits = `${whole}${fraction.padEnd(scale, "0")}`;
      if (
        fraction.length > scale ||
        digits.replace(/^0+/, "").length > precision
      ) {
        throw invalid("decimal", cell);
      }
      const unscaled = BigInt(digits);
      return sign === "-" ? -unscaled : unscaled;
    },
  },
  [Type.Date]: {
    format: (value) => new Date(Number(value)).toISOString().slice(0, 10),
    parse(cell) {
      if (!DATE_TEXT.test(cell)) throw invalid("date", cell);
      return epochMillis(`${cell}T00:00:00Z`, "date", cell);
    },
  },
  [Type.Timestamp]: {
    format(value, type) {
      const iso = new Date(Number(value)).toISOString();
      return hasTimezone(type) ? iso : iso.slice(0, -1);
    },
    parse(cell, type) {
      if (hasTimezone(type)) {
        if (!ZONED_TIMESTAMP_TEXT.test(cell)) throw invalid("timestamp", cell);
        return epochMillis(cell, "timestamp", cell);
      }
      if (!LOCAL_TIMESTAMP_TEXT.test(cell)) throw invalid("timestamp", cell);
      return epochMillis(`${cell}Z`, "timestamp", cell);
    },
  },
  [Type.Bool]: {
    parse(cell) {
      if (cell !== "true" && cell !== "false") throw invalid("boolean", cell);
      return cell === "true";
    },
  },
  [Type.Binary]: {
    parse(cell) {
      if (!BASE64_TEXT.test(cell)) throw invalid("binary", cell);
      return new Uint8Array(Buffer.from(cell, "base64"));
    },
  },
  [Type.Utf8]: {
    parse: (cell) => cell,
  },
};

/** Whether {@link parseJsonArrayCell} can read cells of this Arrow type. */
export function hasJsonArrayCodec(type: DataType): boolean {
  return CODECS[type.typeId] !== undefined;
}

/** Render a scalar Arrow value the way the warehouse writes it under `JSON_ARRAY`. */
export function formatJsonArrayCell(value: unknown, type: DataType): string {
  const format = CODECS[type.typeId]?.format;
  if (format) return format(value, type);
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/** Read a `JSON_ARRAY` cell as a value of `type`. Throws when the text does not fit the type. */
export function parseJsonArrayCell(cell: string, type: DataType): unknown {
  const codec = CODECS[type.typeId];
  if (!codec) throw new Error(`No JSON_ARRAY codec for ${String(type)}`);
  return codec.parse(cell, type);
}
