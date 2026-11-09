import {
  Binary,
  Bool,
  type DataType,
  DateDay,
  Decimal,
  DurationMicrosecond,
  Field,
  Float32,
  Float64,
  Int8,
  Int16,
  Int32,
  Int64,
  IntervalYearMonth,
  List,
  Map_,
  Null,
  Schema,
  Struct,
  Table,
  TimestampMicrosecond,
  tableToIPC,
  Type,
  Utf8,
  type Vector,
  makeData,
  makeVector,
  vectorFromArray,
} from "apache-arrow";

/**
 * Parse a Databricks SQL type text (the value returned by the Statement
 * Execution API in `ColumnInfo.type_text`) into an Apache Arrow DataType.
 *
 * Supports:
 *   - All scalar types (STRING, INT, BIGINT, DECIMAL, TIMESTAMP, etc.)
 *   - Parameterized scalars: DECIMAL(p,s), VARCHAR(n), CHAR(n)
 *   - Nested types: ARRAY<T>, MAP<K,V>, STRUCT<f1:T1, f2:T2 COMMENT '...', ...>
 *   - INTERVAL year-month and day-time variants
 *   - Backtick-quoted struct field names with embedded `` `` `` escapes
 *
 * Unknown or unparseable types fall back to Utf8 — empty-Table consumers
 * still see a column with the right name; only the inner type is degraded.
 */
export function parseDatabricksType(typeText: string): DataType {
  const parser = new TypeParser(typeText);
  const result = parser.parseType();
  parser.expectEnd();
  return result;
}

/**
 * Build an empty Arrow IPC stream (base64-encoded) matching the column schema
 * returned by the warehouse. Used so ARROW_STREAM responses with no rows still
 * deliver a real Arrow Table to the client, preserving the hook's typed
 * contract.
 */
export function buildEmptyArrowIPCBase64(
  columns: Array<{
    name?: string;
    typeText?: string;
    typeName?: string;
  }>,
): string {
  const fields = columns.map((col, index) => {
    const typeText = col.typeText ?? col.typeName ?? "STRING";
    let dataType: DataType;
    try {
      dataType = parseDatabricksType(typeText);
    } catch {
      dataType = new Utf8();
    }
    const name = col.name && col.name.length > 0 ? col.name : `column_${index}`;
    return new Field(name, dataType, true);
  });
  const schema = new Schema(fields);
  const table = new Table(schema);
  const ipc = tableToIPC(table, "stream");
  return Buffer.from(ipc).toString("base64");
}

/** Column metadata from `manifest.schema.columns`. */
export interface ArrowRowColumn {
  name?: string;
  typeText?: string;
  typeName?: string;
  typePrecision?: number;
  typeScale?: number;
}

/**
 * Rebuild the Arrow IPC stream a warehouse serves for `ARROW_STREAM` from the
 * positional string rows of an `INLINE` + `JSON_ARRAY` result. Fields are named
 * `col_N` like the native stream, and each type is what
 * {@link parseDatabricksType} gives that column, with DECIMAL precision and
 * scale taken from `typePrecision` and `typeScale`.
 *
 * Nested, interval, and geospatial columns arrive as strings on the JSON wire
 * and stay strings. A cell that does not parse as its column type throws.
 */
export function buildArrowIPCFromRows(
  columns: ArrowRowColumn[],
  rows: Array<Array<string | null | undefined>>,
): Uint8Array {
  const vectors: Record<string, Vector> = {};
  columns.forEach((col, index) => {
    const cells = rows.map((row) => row[index] ?? null);
    vectors[`col_${index}`] = vectorFromCells(col, cells);
  });
  return tableToIPC(new Table(vectors), "stream");
}

function vectorFromCells(col: ArrowRowColumn, cells: Array<string | null>) {
  const type = rebuildType(col);
  const map = <T>(parse: (cell: string) => T) =>
    cells.map((cell) => (cell === null ? null : parse(cell)));
  switch (type.typeId) {
    case Type.Int: {
      const { bitWidth } = type as unknown as { bitWidth: number };
      return vectorFromArray(
        bitWidth === 64 ? map(parseBigInt) : map(parseInteger),
        type as never,
      );
    }
    case Type.Float:
      return vectorFromArray(map(parseFloatCell), type as never);
    case Type.Bool:
      return vectorFromArray(map(parseBoolean), type as never);
    case Type.Date:
      return vectorFromArray(map(parseUtcMillis), type as never);
    case Type.Timestamp:
      return vectorFromArray(map(parseUtcMillis), type as never);
    case Type.Binary:
      return vectorFromArray(
        map((cell) => new Uint8Array(Buffer.from(cell, "base64"))),
        type as never,
      );
    case Type.Decimal: {
      const { scale, precision } = type as unknown as {
        scale: number;
        precision: number;
      };
      return decimalVector(cells, scale, precision);
    }
    case Type.Null:
      return vectorFromArray(
        cells.map(() => null),
        type as never,
      );
    default:
      return vectorFromArray(cells, new Utf8());
  }
}

const STRING_ONLY_TYPES = new Set<Type>([
  Type.List,
  Type.Struct,
  Type.Map,
  Type.Interval,
  Type.Duration,
]);

function rebuildType(col: ArrowRowColumn): DataType {
  const typeText = col.typeText ?? col.typeName ?? "STRING";
  let type: DataType;
  try {
    type = parseDatabricksType(typeText);
  } catch {
    return new Utf8();
  }
  if (STRING_ONLY_TYPES.has(type.typeId)) return new Utf8();
  // GEOGRAPHY and GEOMETRY map to Binary but arrive as text on the JSON wire.
  if (type.typeId === Type.Binary && typeText.toUpperCase() !== "BINARY") {
    return new Utf8();
  }
  if (type.typeId === Type.Decimal && col.typePrecision != null) {
    return new Decimal(col.typeScale ?? 0, col.typePrecision, 128);
  }
  return type;
}

function parseInteger(cell: string): number {
  const n = Number(cell);
  if (cell.trim() === "" || !Number.isInteger(n)) {
    throw new Error(`Invalid integer "${cell}"`);
  }
  return n;
}

function parseBigInt(cell: string): bigint {
  if (cell.trim() === "") throw new Error(`Invalid integer "${cell}"`);
  return BigInt(cell);
}

function parseFloatCell(cell: string): number {
  const n = Number(cell);
  if (cell.trim() === "" || (Number.isNaN(n) && cell !== "NaN")) {
    throw new Error(`Invalid number "${cell}"`);
  }
  return n;
}

function parseBoolean(cell: string): boolean {
  if (cell !== "true" && cell !== "false") {
    throw new Error(`Invalid boolean "${cell}"`);
  }
  return cell === "true";
}

/** Epoch ms for an ISO date or timestamp; a value with no zone is UTC. */
function parseUtcMillis(cell: string): number {
  const ms = Date.parse(
    /(?:Z|[+-]\d\d(?::?\d\d)?)$/i.test(cell) || !cell.includes("T")
      ? cell
      : `${cell}Z`,
  );
  if (Number.isNaN(ms)) throw new Error(`Invalid date or timestamp "${cell}"`);
  return ms;
}

function decimalVector(
  cells: Array<string | null>,
  scale: number,
  precision: number,
) {
  const words = new Uint32Array(cells.length * 4);
  const validity = new Uint8Array(Math.ceil(cells.length / 8));
  let nullCount = 0;
  cells.forEach((cell, i) => {
    if (cell === null) {
      nullCount++;
      return;
    }
    validity[i >> 3] |= 1 << (i & 7);
    const negative = cell.startsWith("-");
    const [whole, fraction = ""] = cell.replace(/^[-+]/, "").split(".");
    const digits = `${whole}${fraction.padEnd(scale, "0").slice(0, scale)}`;
    if (!/^\d+$/.test(digits)) throw new Error(`Invalid decimal "${cell}"`);
    const unscaled = BigInt(digits);
    const twosComplement = negative ? (1n << 128n) - unscaled : unscaled;
    for (let w = 0; w < 4; w++) {
      words[i * 4 + w] = Number(
        (twosComplement >> BigInt(32 * w)) & 0xffffffffn,
      );
    }
  });
  return makeVector(
    makeData({
      type: new Decimal(scale, precision, 128),
      length: cells.length,
      nullCount,
      nullBitmap: validity,
      data: words,
    }),
  );
}

// ============================================================================
// Recursive-descent parser
// ============================================================================

class TypeParser {
  private readonly input: string;
  private pos = 0;

  constructor(input: string) {
    this.input = input;
  }

  parseType(): DataType {
    this.skipWs();

    let name: string;
    if (this.peek() === "`") {
      name = this.consumeBacktickIdent();
    } else {
      name = this.consumeIdent();
    }
    const upper = name.toUpperCase();

    this.skipWs();

    if (upper === "INTERVAL") {
      return this.parseInterval();
    }

    if (this.peek() === "(") {
      this.consume("(");
      const args = this.parseNumberArgs();
      this.consume(")");
      this.skipWs();
      return this.makeParameterized(upper, args);
    }

    if (this.peek() === "<") {
      this.consume("<");
      const result = this.makeGeneric(upper);
      this.skipWs();
      this.consume(">");
      return result;
    }

    return this.makeScalar(upper);
  }

  expectEnd(): void {
    this.skipWs();
    if (this.pos < this.input.length) {
      throw new Error(
        `Unexpected trailing input at position ${this.pos}: "${this.input.slice(this.pos)}"`,
      );
    }
  }

  // ─── Type constructors ───────────────────────────────────

  private makeScalar(upper: string): DataType {
    switch (upper) {
      case "STRING":
      case "VARIANT":
        return new Utf8();
      case "VARCHAR":
      case "CHAR":
        return new Utf8();
      case "BINARY":
      case "GEOGRAPHY":
      case "GEOMETRY":
        return new Binary();
      case "BOOLEAN":
      case "BOOL":
        return new Bool();
      case "TINYINT":
      case "BYTE":
        return new Int8();
      case "SMALLINT":
      case "SHORT":
        return new Int16();
      case "INT":
      case "INTEGER":
        return new Int32();
      case "BIGINT":
      case "LONG":
        return new Int64();
      case "FLOAT":
      case "REAL":
        return new Float32();
      case "DOUBLE":
        return new Float64();
      case "DECIMAL":
      case "NUMERIC":
      case "DEC":
        return new Decimal(0, 10, 128);
      case "DATE":
        return new DateDay();
      case "TIMESTAMP":
      case "TIMESTAMP_LTZ":
        return new TimestampMicrosecond("UTC");
      case "TIMESTAMP_NTZ":
        return new TimestampMicrosecond();
      case "VOID":
      case "NULL":
        return new Null();
      default:
        return new Utf8();
    }
  }

  private makeParameterized(upper: string, args: number[]): DataType {
    switch (upper) {
      case "DECIMAL":
      case "NUMERIC":
      case "DEC": {
        const precision = args[0] ?? 10;
        const scale = args[1] ?? 0;
        // Arrow JS Decimal constructor signature is (scale, precision, bitWidth).
        return new Decimal(scale, precision, 128);
      }
      case "VARCHAR":
      case "CHAR":
        return new Utf8();
      default:
        return new Utf8();
    }
  }

  private makeGeneric(upper: string): DataType {
    switch (upper) {
      case "ARRAY": {
        const inner = this.parseType();
        return new List(new Field("item", inner, true));
      }
      case "MAP": {
        const keyType = this.parseType();
        this.skipWs();
        this.consume(",");
        this.skipWs();
        const valueType = this.parseType();
        const entriesStruct = new Struct([
          new Field("key", keyType, false),
          new Field("value", valueType, true),
        ]);
        return new Map_(new Field("entries", entriesStruct, false), false);
      }
      case "STRUCT":
        return this.parseStructFields();
      default:
        // Unknown generic — skip to matching '>' and fall back.
        this.skipBalancedAngles();
        return new Utf8();
    }
  }

  private parseStructFields(): DataType {
    const fields: Field[] = [];
    while (true) {
      this.skipWs();
      if (this.peek() === ">") break;

      let name: string;
      if (this.peek() === "`") {
        name = this.consumeBacktickIdent();
      } else {
        name = this.consumeIdent();
      }

      this.skipWs();
      this.consume(":");
      this.skipWs();

      const type = this.parseType();

      // Optional `NOT NULL` and `COMMENT '...'`. Both are accepted by
      // Databricks DDL and may appear in `type_text`.
      this.skipWs();
      while (this.peekKeyword("NOT")) {
        this.consumeIdent();
        this.skipWs();
        if (this.peekKeyword("NULL")) {
          this.consumeIdent();
        }
        this.skipWs();
      }
      if (this.peekKeyword("COMMENT")) {
        this.consumeIdent();
        this.skipWs();
        this.consumeStringLiteral();
        this.skipWs();
      }

      fields.push(new Field(name, type, true));

      this.skipWs();
      if (this.peek() === ",") {
        this.consume(",");
      } else {
        break;
      }
    }
    return new Struct(fields);
  }

  private parseInterval(): DataType {
    // Grammar: INTERVAL <unit> [TO <unit>]
    // YEAR / MONTH variants -> IntervalYearMonth
    // DAY / HOUR / MINUTE / SECOND variants -> Duration(microsecond)
    const seen: string[] = [];
    while (this.pos < this.input.length) {
      this.skipWs();
      const c = this.peek();
      if (c === "" || c === "," || c === ">" || c === ")") break;
      const word = this.consumeIdent().toUpperCase();
      seen.push(word);
    }
    const isYearMonth = seen.some((w) => w === "YEAR" || w === "MONTH");
    return isYearMonth ? new IntervalYearMonth() : new DurationMicrosecond();
  }

  private parseNumberArgs(): number[] {
    const args: number[] = [];
    while (true) {
      this.skipWs();
      if (this.peek() === ")") break;
      args.push(this.consumeNumber());
      this.skipWs();
      if (this.peek() === ",") {
        this.consume(",");
      } else {
        break;
      }
    }
    return args;
  }

  // ─── Token utilities ─────────────────────────────────────

  private peek(): string {
    return this.input[this.pos] ?? "";
  }

  private peekKeyword(word: string): boolean {
    const slice = this.input.slice(this.pos, this.pos + word.length);
    if (slice.toUpperCase() !== word.toUpperCase()) return false;
    // Must be followed by a non-identifier character (boundary check).
    const next = this.input[this.pos + word.length] ?? "";
    return !/[A-Za-z0-9_]/.test(next);
  }

  private consume(expected: string): void {
    if (this.peek() !== expected) {
      throw new Error(
        `Expected "${expected}" at position ${this.pos}, got "${this.peek()}" in "${this.input}"`,
      );
    }
    this.pos++;
  }

  private skipWs(): void {
    while (
      this.pos < this.input.length &&
      /\s/.test(this.input[this.pos] ?? "")
    ) {
      this.pos++;
    }
  }

  private consumeIdent(): string {
    const start = this.pos;
    while (
      this.pos < this.input.length &&
      /[A-Za-z0-9_]/.test(this.input[this.pos] ?? "")
    ) {
      this.pos++;
    }
    if (this.pos === start) {
      throw new Error(
        `Expected identifier at position ${this.pos}, got "${this.peek()}" in "${this.input}"`,
      );
    }
    return this.input.slice(start, this.pos);
  }

  private consumeBacktickIdent(): string {
    this.consume("`");
    let value = "";
    while (this.pos < this.input.length) {
      if (this.input[this.pos] === "`") {
        if (this.input[this.pos + 1] === "`") {
          value += "`";
          this.pos += 2;
          continue;
        }
        break;
      }
      value += this.input[this.pos];
      this.pos++;
    }
    this.consume("`");
    return value;
  }

  private consumeNumber(): number {
    const start = this.pos;
    while (
      this.pos < this.input.length &&
      /[0-9]/.test(this.input[this.pos] ?? "")
    ) {
      this.pos++;
    }
    if (this.pos === start) {
      throw new Error(
        `Expected number at position ${this.pos}, got "${this.peek()}" in "${this.input}"`,
      );
    }
    return Number.parseInt(this.input.slice(start, this.pos), 10);
  }

  private consumeStringLiteral(): string {
    const quote = this.peek();
    if (quote !== "'" && quote !== '"') {
      throw new Error(
        `Expected string literal at position ${this.pos}, got "${quote}" in "${this.input}"`,
      );
    }
    this.pos++;
    let value = "";
    while (this.pos < this.input.length) {
      const c = this.input[this.pos];
      if (c === "\\") {
        // Escape sequence: keep the next char verbatim.
        const next = this.input[this.pos + 1];
        if (next !== undefined) {
          value += next;
          this.pos += 2;
          continue;
        }
        this.pos++;
        continue;
      }
      if (c === quote) {
        this.pos++;
        return value;
      }
      value += c;
      this.pos++;
    }
    throw new Error(`Unterminated string literal in "${this.input}"`);
  }

  private skipBalancedAngles(): void {
    let depth = 1;
    while (this.pos < this.input.length && depth > 0) {
      const c = this.peek();
      if (c === "<") depth++;
      else if (c === ">") {
        depth--;
        if (depth === 0) return;
      }
      this.pos++;
    }
  }
}
