import {
  type DataType,
  type Decimal,
  type Int,
  type Timestamp,
  Type,
} from "apache-arrow";

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

const hasTimezone = (type: Timestamp) => type.timezone != null;

const isDigits = (text: string) =>
  text !== "" && [...text].every((c) => c >= "0" && c <= "9");

const CODECS: Partial<Record<Type, CellCodec>> = {
  [Type.Int]: {
    parse(cell, type: Int) {
      const { bitWidth } = type;
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
      const n = Number(cell);
      if (cell === "" || (Number.isNaN(n) && cell !== "NaN")) {
        throw invalid("number", cell);
      }
      return n;
    },
  },
  [Type.Decimal]: {
    format(value, type: Decimal) {
      const { scale } = type;
      const unscaled = String(value);
      if (scale <= 0) return unscaled;
      const negative = unscaled.startsWith("-");
      let digits = negative ? unscaled.slice(1) : unscaled;
      if (digits.length <= scale) digits = digits.padStart(scale + 1, "0");
      const point = digits.length - scale;
      const out = `${digits.slice(0, point)}.${digits.slice(point)}`;
      return negative ? `-${out}` : out;
    },
    parse(cell, type: Decimal) {
      const negative = cell.startsWith("-");
      const [whole, fraction = "", extra] = (
        negative ? cell.slice(1) : cell
      ).split(".");
      if (
        extra !== undefined ||
        !isDigits(whole) ||
        (fraction !== "" && !isDigits(fraction)) ||
        fraction.length > type.scale
      ) {
        throw invalid("decimal", cell);
      }
      const unscaled = BigInt(`${whole}${fraction.padEnd(type.scale, "0")}`);
      if (String(unscaled).length > type.precision) {
        throw invalid("decimal", cell);
      }
      return negative ? -unscaled : unscaled;
    },
  },
  [Type.Date]: {
    format: (value) => new Date(Number(value)).toISOString().slice(0, 10),
    parse: (cell) => epochMillis(`${cell}T00:00:00Z`, "date", cell),
  },
  [Type.Timestamp]: {
    format(value, type: Timestamp) {
      const iso = new Date(Number(value)).toISOString();
      return hasTimezone(type) ? iso : iso.slice(0, -1);
    },
    parse(cell, type: Timestamp) {
      // A cell that already ends in `Z` or `±hh:mm` stops parsing once another
      // `Z` is appended. A zoned cell without one would be read in the server's zone.
      const hasOffset = Number.isNaN(Date.parse(`${cell}Z`));
      if (hasOffset !== hasTimezone(type)) throw invalid("timestamp", cell);
      return epochMillis(hasOffset ? cell : `${cell}Z`, "timestamp", cell);
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
      // Buffer skips characters that aren't base64, so re-encode to catch them.
      const bytes = Buffer.from(cell, "base64");
      if (bytes.toString("base64") !== cell) throw invalid("binary", cell);
      return new Uint8Array(bytes);
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
