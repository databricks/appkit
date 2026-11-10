import { readFileSync } from "node:fs";

import {
  Binary,
  Bool,
  type DataType,
  DateDay,
  Decimal,
  DurationMicrosecond,
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
  Struct,
  TimestampMicrosecond,
  Type,
  tableFromIPC,
  Utf8,
} from "apache-arrow";
import { describe, expect, test } from "vitest";

import type { ColumnInfo } from "../../../workspace-client";
import {
  buildArrowIPCFromRows,
  buildEmptyArrowIPCBase64,
  parseDatabricksType,
} from "../arrow-schema";

// ============================================================================
// Helpers
// ============================================================================

/** Walk the type tree and produce a stable string representation for assertions. */
function typeSummary(t: DataType): string {
  if (t instanceof Decimal) return `Decimal(${t.precision},${t.scale})`;
  if (t instanceof TimestampMicrosecond) {
    const tz = (t as TimestampMicrosecond & { timezone?: string }).timezone;
    return tz ? `Timestamp[us,${tz}]` : "Timestamp[us]";
  }
  if (t instanceof List) {
    const inner = (t.children?.[0]?.type as DataType | undefined) ?? new Utf8();
    return `List<${typeSummary(inner)}>`;
  }
  if (t instanceof Struct) {
    const inner = (t.children ?? [])
      .map((f) => `${f.name}:${typeSummary(f.type as DataType)}`)
      .join(",");
    return `Struct<${inner}>`;
  }
  if (t instanceof Map_) {
    const entries =
      (t.children?.[0]?.type as Struct | undefined)?.children ?? [];
    const k = entries[0]?.type as DataType | undefined;
    const v = entries[1]?.type as DataType | undefined;
    return `Map<${typeSummary(k ?? new Utf8())},${typeSummary(v ?? new Utf8())}>`;
  }
  // Fall back to typeId for primitives.
  return Type[t.typeId] ?? t.constructor.name;
}

// ============================================================================
// Scalar types
// ============================================================================

describe("parseDatabricksType — scalars", () => {
  test.each([
    ["STRING", Utf8],
    ["VARIANT", Utf8],
    ["BINARY", Binary],
    ["GEOGRAPHY", Binary],
    ["GEOMETRY", Binary],
    ["BOOLEAN", Bool],
    ["BOOL", Bool],
    ["TINYINT", Int8],
    ["BYTE", Int8],
    ["SMALLINT", Int16],
    ["SHORT", Int16],
    ["INT", Int32],
    ["INTEGER", Int32],
    ["BIGINT", Int64],
    ["LONG", Int64],
    ["FLOAT", Float32],
    ["REAL", Float32],
    ["DOUBLE", Float64],
    ["DATE", DateDay],
    ["VOID", Null],
    ["NULL", Null],
  ] as const)("%s parses to expected type", (input, ctor) => {
    const t = parseDatabricksType(input);
    expect(t).toBeInstanceOf(ctor);
  });

  test("case-insensitive — lowercase is accepted", () => {
    expect(parseDatabricksType("string")).toBeInstanceOf(Utf8);
    expect(parseDatabricksType("bigint")).toBeInstanceOf(Int64);
  });

  test("TIMESTAMP defaults to UTC tz", () => {
    const t = parseDatabricksType("TIMESTAMP") as TimestampMicrosecond;
    expect(t).toBeInstanceOf(TimestampMicrosecond);
    expect(t.timezone).toBe("UTC");
  });

  test("TIMESTAMP_LTZ behaves like TIMESTAMP", () => {
    const t = parseDatabricksType("TIMESTAMP_LTZ") as TimestampMicrosecond;
    expect(t.timezone).toBe("UTC");
  });

  test("TIMESTAMP_NTZ has no timezone", () => {
    const t = parseDatabricksType("TIMESTAMP_NTZ") as TimestampMicrosecond;
    expect(t).toBeInstanceOf(TimestampMicrosecond);
    expect(t.timezone == null || t.timezone === "").toBe(true);
  });

  test("Unknown scalar falls back to Utf8 (degraded but doesn't throw)", () => {
    expect(parseDatabricksType("SOMETHING_NEW")).toBeInstanceOf(Utf8);
  });
});

// ============================================================================
// Parameterized scalars
// ============================================================================

describe("parseDatabricksType — parameterized scalars", () => {
  test("VARCHAR(255) → Utf8 (Arrow doesn't track string length)", () => {
    expect(parseDatabricksType("VARCHAR(255)")).toBeInstanceOf(Utf8);
  });

  test("CHAR(10) → Utf8", () => {
    expect(parseDatabricksType("CHAR(10)")).toBeInstanceOf(Utf8);
  });

  test("DECIMAL(10,2) → Decimal(precision=10, scale=2)", () => {
    const t = parseDatabricksType("DECIMAL(10,2)") as Decimal;
    expect(t).toBeInstanceOf(Decimal);
    expect(t.precision).toBe(10);
    expect(t.scale).toBe(2);
  });

  test("DECIMAL(38,0) — max precision, no scale", () => {
    const t = parseDatabricksType("DECIMAL(38,0)") as Decimal;
    expect(t.precision).toBe(38);
    expect(t.scale).toBe(0);
  });

  test("NUMERIC(p,s) is an alias for DECIMAL(p,s)", () => {
    const t = parseDatabricksType("NUMERIC(15,4)") as Decimal;
    expect(t).toBeInstanceOf(Decimal);
    expect(t.precision).toBe(15);
    expect(t.scale).toBe(4);
  });

  test("DEC(p,s) is an alias for DECIMAL(p,s)", () => {
    const t = parseDatabricksType("DEC(7,3)") as Decimal;
    expect(t.precision).toBe(7);
    expect(t.scale).toBe(3);
  });

  test("DECIMAL with whitespace inside parens", () => {
    const t = parseDatabricksType("DECIMAL( 10 , 2 )") as Decimal;
    expect(t.precision).toBe(10);
    expect(t.scale).toBe(2);
  });

  test("DECIMAL with single arg (precision only) defaults scale=0", () => {
    const t = parseDatabricksType("DECIMAL(20)") as Decimal;
    expect(t.precision).toBe(20);
    expect(t.scale).toBe(0);
  });

  test("Bare DECIMAL falls back to default precision/scale", () => {
    const t = parseDatabricksType("DECIMAL") as Decimal;
    expect(t).toBeInstanceOf(Decimal);
    expect(typeof t.precision).toBe("number");
    expect(typeof t.scale).toBe("number");
  });
});

// ============================================================================
// INTERVAL types
// ============================================================================

describe("parseDatabricksType — INTERVAL", () => {
  test("INTERVAL YEAR → IntervalYearMonth", () => {
    expect(parseDatabricksType("INTERVAL YEAR")).toBeInstanceOf(
      IntervalYearMonth,
    );
  });

  test("INTERVAL MONTH → IntervalYearMonth", () => {
    expect(parseDatabricksType("INTERVAL MONTH")).toBeInstanceOf(
      IntervalYearMonth,
    );
  });

  test("INTERVAL YEAR TO MONTH → IntervalYearMonth", () => {
    expect(parseDatabricksType("INTERVAL YEAR TO MONTH")).toBeInstanceOf(
      IntervalYearMonth,
    );
  });

  test("INTERVAL DAY → DurationMicrosecond", () => {
    expect(parseDatabricksType("INTERVAL DAY")).toBeInstanceOf(
      DurationMicrosecond,
    );
  });

  test("INTERVAL DAY TO SECOND → DurationMicrosecond", () => {
    expect(parseDatabricksType("INTERVAL DAY TO SECOND")).toBeInstanceOf(
      DurationMicrosecond,
    );
  });

  test("INTERVAL HOUR TO MINUTE → DurationMicrosecond", () => {
    expect(parseDatabricksType("INTERVAL HOUR TO MINUTE")).toBeInstanceOf(
      DurationMicrosecond,
    );
  });
});

// ============================================================================
// ARRAY
// ============================================================================

describe("parseDatabricksType — ARRAY", () => {
  test("ARRAY<STRING> → List<Utf8>", () => {
    const t = parseDatabricksType("ARRAY<STRING>") as List;
    expect(t).toBeInstanceOf(List);
    expect(t.children?.[0]?.type).toBeInstanceOf(Utf8);
  });

  test("ARRAY<INT> → List<Int32>", () => {
    const t = parseDatabricksType("ARRAY<INT>") as List;
    expect(t.children?.[0]?.type).toBeInstanceOf(Int32);
  });

  test("ARRAY<DECIMAL(10,2)> preserves precision/scale", () => {
    const t = parseDatabricksType("ARRAY<DECIMAL(10,2)>") as List;
    const inner = t.children?.[0]?.type as Decimal;
    expect(inner).toBeInstanceOf(Decimal);
    expect(inner.precision).toBe(10);
    expect(inner.scale).toBe(2);
  });

  test("ARRAY<ARRAY<INT>> — nested twice", () => {
    const t = parseDatabricksType("ARRAY<ARRAY<INT>>") as List;
    const inner1 = t.children?.[0]?.type as List;
    expect(inner1).toBeInstanceOf(List);
    expect(inner1.children?.[0]?.type).toBeInstanceOf(Int32);
  });

  test("ARRAY<ARRAY<ARRAY<STRING>>> — three levels deep", () => {
    expect(
      typeSummary(parseDatabricksType("ARRAY<ARRAY<ARRAY<STRING>>>")),
    ).toBe("List<List<List<Utf8>>>");
  });

  test("ARRAY with whitespace", () => {
    const t = parseDatabricksType("ARRAY < STRING >") as List;
    expect(t.children?.[0]?.type).toBeInstanceOf(Utf8);
  });
});

// ============================================================================
// MAP
// ============================================================================

describe("parseDatabricksType — MAP", () => {
  test("MAP<STRING,INT>", () => {
    expect(typeSummary(parseDatabricksType("MAP<STRING,INT>"))).toBe(
      "Map<Utf8,Int>",
    );
  });

  test("MAP<STRING, BIGINT> — with whitespace", () => {
    expect(typeSummary(parseDatabricksType("MAP<STRING, BIGINT>"))).toBe(
      "Map<Utf8,Int>",
    );
  });

  test("MAP<STRING, ARRAY<INT>> — value is nested", () => {
    expect(typeSummary(parseDatabricksType("MAP<STRING, ARRAY<INT>>"))).toBe(
      "Map<Utf8,List<Int>>",
    );
  });

  test("MAP<INT, MAP<STRING, DOUBLE>> — fully nested", () => {
    expect(
      typeSummary(parseDatabricksType("MAP<INT, MAP<STRING, DOUBLE>>")),
    ).toBe("Map<Int,Map<Utf8,Float>>");
  });
});

// ============================================================================
// STRUCT
// ============================================================================

describe("parseDatabricksType — STRUCT", () => {
  test("STRUCT<a:INT,b:STRING>", () => {
    const t = parseDatabricksType("STRUCT<a:INT,b:STRING>") as Struct;
    expect(t).toBeInstanceOf(Struct);
    expect(t.children?.length).toBe(2);
    expect(t.children?.[0]?.name).toBe("a");
    expect(t.children?.[0]?.type).toBeInstanceOf(Int32);
    expect(t.children?.[1]?.name).toBe("b");
    expect(t.children?.[1]?.type).toBeInstanceOf(Utf8);
  });

  test("STRUCT with whitespace and many fields", () => {
    const t = parseDatabricksType(
      "STRUCT<id: BIGINT, name: STRING, ts: TIMESTAMP>",
    ) as Struct;
    expect(t.children?.map((f) => f.name)).toEqual(["id", "name", "ts"]);
    expect(t.children?.[0]?.type).toBeInstanceOf(Int64);
    expect(t.children?.[2]?.type).toBeInstanceOf(TimestampMicrosecond);
  });

  test("STRUCT with COMMENT on a field", () => {
    const t = parseDatabricksType(
      "STRUCT<id:INT COMMENT 'primary key', name:STRING>",
    ) as Struct;
    expect(t.children?.length).toBe(2);
    expect(t.children?.[0]?.name).toBe("id");
    expect(t.children?.[0]?.type).toBeInstanceOf(Int32);
    expect(t.children?.[1]?.name).toBe("name");
  });

  test("STRUCT with COMMENT containing escaped quote", () => {
    const t = parseDatabricksType(
      "STRUCT<id:INT COMMENT 'has \\'apostrophe\\' inside', name:STRING>",
    ) as Struct;
    expect(t.children?.length).toBe(2);
    expect(t.children?.[0]?.name).toBe("id");
  });

  test("STRUCT with NOT NULL annotation on a field", () => {
    const t = parseDatabricksType(
      "STRUCT<id:INT NOT NULL, name:STRING>",
    ) as Struct;
    expect(t.children?.length).toBe(2);
    expect(t.children?.[0]?.name).toBe("id");
  });

  test("STRUCT with backticked field name", () => {
    const t = parseDatabricksType(
      "STRUCT<`weird name`:INT, normal:STRING>",
    ) as Struct;
    expect(t.children?.[0]?.name).toBe("weird name");
    expect(t.children?.[0]?.type).toBeInstanceOf(Int32);
  });

  test("STRUCT with backticked field name containing escaped backtick", () => {
    const t = parseDatabricksType(
      "STRUCT<`with``tick`:INT, other:STRING>",
    ) as Struct;
    expect(t.children?.[0]?.name).toBe("with`tick");
  });

  test("STRUCT with nested STRUCT", () => {
    const t = parseDatabricksType(
      "STRUCT<outer:STRUCT<inner:INT>, name:STRING>",
    ) as Struct;
    expect(t.children?.length).toBe(2);
    const nested = t.children?.[0]?.type as Struct;
    expect(nested).toBeInstanceOf(Struct);
    expect(nested.children?.[0]?.name).toBe("inner");
    expect(nested.children?.[0]?.type).toBeInstanceOf(Int32);
  });

  test("Empty STRUCT<>", () => {
    const t = parseDatabricksType("STRUCT<>") as Struct;
    expect(t).toBeInstanceOf(Struct);
    expect(t.children?.length).toBe(0);
  });
});

// ============================================================================
// Deep nesting / mixed types
// ============================================================================

describe("parseDatabricksType — deeply nested", () => {
  test("MAP<STRING, ARRAY<STRUCT<x:INT, y:DECIMAL(5,2)>>>", () => {
    expect(
      typeSummary(
        parseDatabricksType(
          "MAP<STRING, ARRAY<STRUCT<x:INT, y:DECIMAL(5,2)>>>",
        ),
      ),
    ).toBe("Map<Utf8,List<Struct<x:Int,y:Decimal(5,2)>>>");
  });

  test("ARRAY<MAP<STRING,STRUCT<id:BIGINT,tags:ARRAY<STRING>>>> — 4 levels mixed", () => {
    expect(
      typeSummary(
        parseDatabricksType(
          "ARRAY<MAP<STRING,STRUCT<id:BIGINT,tags:ARRAY<STRING>>>>",
        ),
      ),
    ).toBe("List<Map<Utf8,Struct<id:Int,tags:List<Utf8>>>>");
  });
});

// ============================================================================
// Error / robustness behavior
// ============================================================================

describe("parseDatabricksType — error / robustness", () => {
  test("trailing garbage throws", () => {
    expect(() => parseDatabricksType("INT junk")).toThrow();
  });

  test("unmatched < throws", () => {
    expect(() => parseDatabricksType("ARRAY<INT")).toThrow();
  });

  test("unmatched paren throws", () => {
    expect(() => parseDatabricksType("DECIMAL(10,2")).toThrow();
  });

  test("empty string throws", () => {
    expect(() => parseDatabricksType("")).toThrow();
  });
});

// ============================================================================
// buildEmptyArrowIPCBase64 — round-trip
// ============================================================================

describe("buildEmptyArrowIPCBase64", () => {
  test("produces a decodable empty Arrow Table with the right schema", () => {
    const columns = [
      { name: "user_id", typeText: "BIGINT" },
      { name: "name", typeText: "STRING" },
      { name: "created_at", typeText: "TIMESTAMP" },
      { name: "balance", typeText: "DECIMAL(10,2)" },
      { name: "active", typeText: "BOOLEAN" },
    ];
    const b64 = buildEmptyArrowIPCBase64(columns);
    const buf = Buffer.from(b64, "base64");
    const table = tableFromIPC(buf);
    expect(table.numRows).toBe(0);
    expect(table.numCols).toBe(5);
    expect(table.schema.fields.map((f) => f.name)).toEqual([
      "user_id",
      "name",
      "created_at",
      "balance",
      "active",
    ]);
    expect(
      (table.schema.fields[0]?.type as { bitWidth?: number }).bitWidth,
    ).toBe(64);
    expect(table.schema.fields[1]?.type).toBeInstanceOf(Utf8);
    // After IPC round-trip Arrow JS resolves Timestamp* subclasses to a
    // generic Timestamp with `unit` and `timezone`; assert structurally.
    expect(table.schema.fields[2]?.type.typeId).toBe(Type.Timestamp);
    expect((table.schema.fields[2]?.type as { unit?: number }).unit).toBe(2); // TimeUnit.MICROSECOND
    const decimal = table.schema.fields[3]?.type as Decimal;
    expect(decimal).toBeInstanceOf(Decimal);
    expect(decimal.precision).toBe(10);
    expect(decimal.scale).toBe(2);
    expect(table.schema.fields[4]?.type).toBeInstanceOf(Bool);
  });

  test("round-trips nested types end-to-end", () => {
    const columns = [
      { name: "tags", typeText: "ARRAY<STRING>" },
      { name: "meta", typeText: "STRUCT<source:STRING, version:INT>" },
      { name: "counts", typeText: "MAP<STRING, BIGINT>" },
    ];
    const buf = Buffer.from(buildEmptyArrowIPCBase64(columns), "base64");
    const table = tableFromIPC(buf);
    expect(table.numRows).toBe(0);
    expect(table.numCols).toBe(3);
    expect(table.schema.fields[0]?.type).toBeInstanceOf(List);
    expect(table.schema.fields[1]?.type).toBeInstanceOf(Struct);
    expect(table.schema.fields[2]?.type).toBeInstanceOf(Map_);
  });

  test("falls back from typeText to typeName when typeText missing", () => {
    const columns = [{ name: "id", typeName: "BIGINT" }];
    const buf = Buffer.from(buildEmptyArrowIPCBase64(columns), "base64");
    const table = tableFromIPC(buf);
    expect(
      (table.schema.fields[0]?.type as { bitWidth?: number }).bitWidth,
    ).toBe(64);
  });

  test("unknown type degrades to Utf8 without throwing", () => {
    const columns = [
      { name: "id", typeText: "BIGINT" },
      { name: "weird", typeText: "FUTURE_TYPE_NOT_YET_SUPPORTED" },
    ];
    const buf = Buffer.from(buildEmptyArrowIPCBase64(columns), "base64");
    const table = tableFromIPC(buf);
    expect(
      (table.schema.fields[0]?.type as { bitWidth?: number }).bitWidth,
    ).toBe(64);
    expect(table.schema.fields[1]?.type).toBeInstanceOf(Utf8);
  });

  test("missing column name gets a synthesized placeholder", () => {
    const columns = [{ typeText: "STRING" }, { name: "", typeText: "INT" }];
    const buf = Buffer.from(buildEmptyArrowIPCBase64(columns), "base64");
    const table = tableFromIPC(buf);
    expect(table.schema.fields[0]?.name).toBe("column_0");
    expect(table.schema.fields[1]?.name).toBe("column_1");
  });

  test("empty schema produces a valid 0-column 0-row Table", () => {
    const buf = Buffer.from(buildEmptyArrowIPCBase64([]), "base64");
    const table = tableFromIPC(buf);
    expect(table.numRows).toBe(0);
    expect(table.numCols).toBe(0);
  });
});

// ============================================================================
// buildArrowIPCFromRows (rebuilds ARROW_STREAM from INLINE JSON_ARRAY rows)
// ============================================================================

describe("buildArrowIPCFromRows", () => {
  type Case = {
    column: Parameters<typeof buildArrowIPCFromRows>[0][number];
    cells: Array<string | null>;
    expected: unknown[];
  };

  const decimalUnscaled = (v: unknown) =>
    v === null ? null : String(v as { toString(): string });
  const cases: Record<string, Case & { read?: (v: unknown) => unknown }> = {
    INT: {
      column: { name: "c", typeName: "INT", typeText: "INT" },
      cells: ["1", null, "-3"],
      expected: [1, null, -3],
    },
    TINYINT: {
      column: { name: "c", typeName: "BYTE", typeText: "TINYINT" },
      cells: ["7", null, "-128"],
      expected: [7, null, -128],
    },
    SMALLINT: {
      column: { name: "c", typeName: "SHORT", typeText: "SMALLINT" },
      cells: ["32767", null],
      expected: [32767, null],
    },
    BIGINT: {
      column: { name: "c", typeName: "LONG", typeText: "BIGINT" },
      cells: ["9007199254740993", null, "-9223372036854775808"],
      expected: [9007199254740993n, null, -9223372036854775808n],
    },
    FLOAT: {
      column: { name: "c", typeName: "FLOAT", typeText: "FLOAT" },
      cells: ["1.5", null, "-0.25"],
      expected: [1.5, null, -0.25],
    },
    DOUBLE: {
      column: { name: "c", typeName: "DOUBLE", typeText: "DOUBLE" },
      cells: ["1.1", "NaN", null],
      expected: [1.1, Number.NaN, null],
    },
    DECIMAL: {
      column: {
        name: "c",
        typeName: "DECIMAL",
        typeText: "DECIMAL(10,2)",
        typePrecision: 10,
        typeScale: 2,
      },
      cells: ["1.50", "-0.05", null, "12345678.99", "7"],
      expected: ["150", "-5", null, "1234567899", "700"],
      read: decimalUnscaled,
    },
    "DECIMAL without (p,s) in typeText": {
      column: {
        name: "c",
        typeName: "DECIMAL",
        typeText: "DECIMAL",
        typePrecision: 12,
        typeScale: 3,
      },
      cells: ["1.5", null],
      expected: ["1500", null],
      read: decimalUnscaled,
    },
    DATE: {
      column: { name: "c", typeName: "DATE", typeText: "DATE" },
      cells: ["2026-01-02", null],
      expected: [Date.UTC(2026, 0, 2), null],
    },
    TIMESTAMP: {
      column: { name: "c", typeName: "TIMESTAMP", typeText: "TIMESTAMP" },
      cells: ["2026-01-02T10:00:00.123Z", null],
      expected: [Date.UTC(2026, 0, 2, 10, 0, 0, 123), null],
    },
    TIMESTAMP_NTZ: {
      column: {
        name: "c",
        typeName: "TIMESTAMP_NTZ",
        typeText: "TIMESTAMP_NTZ",
      },
      cells: ["2026-01-02T10:00:00.123", null],
      expected: [Date.UTC(2026, 0, 2, 10, 0, 0, 123), null],
    },
    STRING: {
      column: { name: "c", typeName: "STRING", typeText: "STRING" },
      cells: ["a", "", null],
      expected: ["a", "", null],
    },
    BOOLEAN: {
      column: { name: "c", typeName: "BOOLEAN", typeText: "BOOLEAN" },
      cells: ["true", "false", null],
      expected: [true, false, null],
    },
    BINARY: {
      column: { name: "c", typeName: "BINARY", typeText: "BINARY" },
      cells: ["AQI=", null],
      expected: [[1, 2], null],
      read: (v) => (v === null ? null : [...(v as Uint8Array)]),
    },
    VOID: {
      column: { name: "c", typeName: "NULL", typeText: "VOID" },
      cells: [null, null],
      expected: [null, null],
    },
  };

  test.each(Object.entries(cases))(
    "%s keeps the native Arrow type and values, nulls included",
    (_name, { column, cells, expected, read }) => {
      const ipc = buildArrowIPCFromRows(
        [column],
        cells.map((cell) => [cell]),
      );
      const table = tableFromIPC(ipc);

      const native = parseDatabricksType(column.typeText ?? "STRING");
      const field = table.schema.fields[0];
      expect(field.name).toBe(column.name);
      expect(field.typeId).toBe(native.typeId);
      if (column.typeName === "DECIMAL") {
        const type = field.type as Decimal;
        expect([type.precision, type.scale]).toEqual([
          column.typePrecision,
          column.typeScale,
        ]);
      } else {
        expect(String(field.type)).toBe(String(native));
      }
      const values = [...(table.getChildAt(0) as Iterable<unknown>)];
      expect(values.map((v) => (read ? read(v) : v))).toEqual(expected);
    },
  );

  test("duplicate column names and JSON-looking strings come through verbatim", () => {
    const payload = '{"id":9007199254740993, "label":"kept verbatim"}';
    const ipc = buildArrowIPCFromRows(
      [
        { name: "x", typeName: "INT", typeText: "INT" },
        { name: "x", typeName: "INT", typeText: "INT" },
        { name: "payload", typeName: "STRING", typeText: "STRING" },
      ],
      [["1", "2", payload]],
    );
    const table = tableFromIPC(ipc);
    expect(table.schema.fields.map((f) => f.name)).toEqual([
      "x",
      "x",
      "payload",
    ]);
    expect(table.getChildAt(0)?.get(0)).toBe(1);
    expect(table.getChildAt(1)?.get(0)).toBe(2);
    expect(table.getChildAt(2)?.get(0)).toBe(payload);
  });

  test("an unnamed column gets the column_N name the header carries", () => {
    const ipc = buildArrowIPCFromRows([{ name: "", typeText: "INT" }], [["1"]]);
    expect(tableFromIPC(ipc).schema.fields[0].name).toBe("column_0");
  });

  test("nested, interval and geospatial columns stay strings", () => {
    const columns = [
      { name: "a", typeText: "ARRAY<INT>" },
      { name: "m", typeText: "MAP<STRING,INT>" },
      { name: "s", typeText: "STRUCT<f:INT>" },
      { name: "i", typeText: "INTERVAL DAY" },
      { name: "g", typeName: "GEOGRAPHY", typeText: "GEOGRAPHY(4326)" },
    ];
    const row = [
      "[1,2]",
      '{"k":1}',
      '{"f":1}',
      "1 00:00:00.000000000",
      "POINT(1 2)",
    ];
    const table = tableFromIPC(buildArrowIPCFromRows(columns, [row]));
    expect(table.schema.fields.map((f) => f.typeId)).toEqual(
      columns.map(() => Type.Utf8),
    );
    expect(table.toArray()[0].toJSON()).toEqual({
      a: row[0],
      m: row[1],
      s: row[2],
      i: row[3],
      g: row[4],
    });
  });

  test("zero rows still yield the typed schema", () => {
    const table = tableFromIPC(
      buildArrowIPCFromRows(
        [{ name: "n", typeName: "LONG", typeText: "BIGINT" }],
        [],
      ),
    );
    expect(table.numRows).toBe(0);
    expect(table.schema.fields[0].typeId).toBe(Type.Int);
  });

  test("a cell that does not parse as its column type throws", () => {
    expect(() =>
      buildArrowIPCFromRows(
        [{ typeText: "INT" }, { typeText: "DATE" }],
        [["1", "not-a-date"]],
      ),
    ).toThrow(/Invalid date/);
    expect(() =>
      buildArrowIPCFromRows(
        [{ typeText: "DECIMAL(5,2)", typePrecision: 5, typeScale: 2 }],
        [["abc"]],
      ),
    ).toThrow(/Invalid decimal/);
    expect(() =>
      buildArrowIPCFromRows([{ typeText: "INT" }], [["abc"]]),
    ).toThrow(/Invalid integer/);
    expect(() =>
      buildArrowIPCFromRows([{ typeText: "BIGINT" }], [["1.5"]]),
    ).toThrow();
    expect(() =>
      buildArrowIPCFromRows([{ typeText: "DOUBLE" }], [["x"]]),
    ).toThrow(/Invalid number/);
    expect(() =>
      buildArrowIPCFromRows([{ typeText: "BOOLEAN" }], [["maybe"]]),
    ).toThrow(/Invalid boolean/);
  });
});

describe("buildArrowIPCFromRows against a captured warehouse response", () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL("./fixtures/typed-values.json", import.meta.url),
      "utf8",
    ),
  ) as {
    columns: ColumnInfo[];
    dataArray: Array<Array<string | null>>;
    arrowIpcBase64: string;
  };
  const native = tableFromIPC(Buffer.from(fixture.arrowIpcBase64, "base64"));
  const rebuilt = tableFromIPC(
    buildArrowIPCFromRows(fixture.columns, fixture.dataArray),
  );
  const comparable = (value: unknown) =>
    value !== null && typeof value === "object" ? String(value) : value;
  const values = (table: typeof native, index: number) =>
    [...(table.getChildAt(index) ?? [])].map(comparable);
  const SESSION_ZONE = "America/Los_Angeles";

  test("has the same rows and column names, duplicates included", () => {
    expect(rebuilt.numRows).toBe(native.numRows);
    expect(rebuilt.schema.fields.map((f) => f.name)).toEqual(
      native.schema.fields.map((f) => f.name),
    );
  });

  test.each(
    fixture.columns
      .map((column, index) => [column.name ?? "", index] as const)
      .filter(([name]) => !["ts", "ts_micro", "arr"].includes(name)),
  )("column %s (%i) has the native Arrow type and values", (_name, index) => {
    expect(String(rebuilt.schema.fields[index].type)).toBe(
      String(native.schema.fields[index].type),
    );
    expect(values(rebuilt, index)).toEqual(values(native, index));
  });

  test("TIMESTAMP keeps every instant but is labeled UTC instead of the session zone", () => {
    const index = fixture.columns.findIndex((c) => c.name === "ts");
    expect(native.schema.fields[index].type.timezone).toBe(SESSION_ZONE);
    expect(rebuilt.schema.fields[index].type.timezone).toBe("UTC");
    expect(values(rebuilt, index)).toEqual(values(native, index));
  });

  test("TIMESTAMP keeps milliseconds, because the JSON text has no microseconds", () => {
    const index = fixture.columns.findIndex((c) => c.name === "ts_micro");
    expect(fixture.dataArray[0][index]).toMatch(/\.\d{3}-\d{2}:\d{2}$/);
    expect(values(rebuilt, index)).toEqual(
      values(native, index).map((ms) =>
        ms === null ? null : Math.trunc(ms as number),
      ),
    );
  });

  test("ARRAY arrives as JSON text and stays a string column", () => {
    const index = fixture.columns.findIndex((c) => c.name === "arr");
    expect(native.schema.fields[index].type.typeId).toBe(Type.List);
    expect(rebuilt.schema.fields[index].type.typeId).toBe(Type.Utf8);
    expect(values(rebuilt, index)).toEqual(
      fixture.dataArray.map((row) => row[index]),
    );
  });
});
