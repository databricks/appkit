import { type DataType, Type } from "apache-arrow";

/**
 * How one scalar type is written in an `INLINE` + `JSON_ARRAY` cell. `parse`
 * returns what `vectorFromArray` accepts: an unscaled `bigint` for DECIMAL,
 * epoch milliseconds for DATE and TIMESTAMP.
 */
interface CellCodec {
  format(value: unknown, type: DataType): string;
  parse(cell: string, type: DataType): unknown;
}

const DECIMAL_TEXT = /^(-?)(\d+)(?:\.(\d+))?$/;
const DATE_TEXT = /^\d{4}-\d{2}-\d{2}$/;
/** `TIMESTAMP` cells carry the session offset (or `Z`); `TIMESTAMP_NTZ` cells carry none. */
const ZONED_TIMESTAMP_TEXT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const LOCAL_TIMESTAMP_TEXT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

function invalid(kind: string, cell: string): Error {
  return new Error(`Invalid ${kind} "${cell}"`);
}

function epochMillis(text: string, kind: string, cell: string): number {
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) throw invalid(kind, cell);
  return ms;
}

const hasTimezone = (type: DataType) =>
  (type as DataType & { timezone?: string | null }).timezone != null;

const CODECS: Partial<Record<Type, CellCodec>> = {
  [Type.Int]: {
    format: (value) => String(value),
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
    format: (value) => String(value),
    parse(cell) {
      const n = Number(cell);
      if (cell.trim() === "" || (Number.isNaN(n) && cell !== "NaN")) {
        throw invalid("number", cell);
      }
      return n;
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
      const { scale } = type as DataType & { scale: number };
      const match = DECIMAL_TEXT.exec(cell);
      const [, sign, whole, fraction = ""] = match ?? [];
      if (!match || fraction.length > scale) throw invalid("decimal", cell);
      const unscaled = BigInt(`${whole}${fraction.padEnd(scale, "0")}`);
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
    format: (value) => String(value),
    parse(cell) {
      if (cell !== "true" && cell !== "false") throw invalid("boolean", cell);
      return cell === "true";
    },
  },
  [Type.Binary]: {
    format: (value) => Buffer.from(value as Uint8Array).toString("base64"),
    parse: (cell) => new Uint8Array(Buffer.from(cell, "base64")),
  },
  [Type.Utf8]: {
    format: (value) => String(value),
    parse: (cell) => cell,
  },
};

/** Whether {@link parseJsonArrayCell} can read cells of this Arrow type. */
export function hasJsonArrayCodec(type: DataType): boolean {
  return CODECS[type.typeId] !== undefined;
}

/** Render a scalar Arrow value the way the warehouse writes it under `JSON_ARRAY`. */
export function formatJsonArrayCell(value: unknown, type: DataType): string {
  const codec = CODECS[type.typeId];
  if (codec) return codec.format(value, type);
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
