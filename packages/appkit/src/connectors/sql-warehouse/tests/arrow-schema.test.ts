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

import { buildEmptyArrowIPCBase64, parseDatabricksType } from "../arrow-schema";

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
      { name: "user_id", type_text: "BIGINT" },
      { name: "name", type_text: "STRING" },
      { name: "created_at", type_text: "TIMESTAMP" },
      { name: "balance", type_text: "DECIMAL(10,2)" },
      { name: "active", type_text: "BOOLEAN" },
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
      { name: "tags", type_text: "ARRAY<STRING>" },
      { name: "meta", type_text: "STRUCT<source:STRING, version:INT>" },
      { name: "counts", type_text: "MAP<STRING, BIGINT>" },
    ];
    const buf = Buffer.from(buildEmptyArrowIPCBase64(columns), "base64");
    const table = tableFromIPC(buf);
    expect(table.numRows).toBe(0);
    expect(table.numCols).toBe(3);
    expect(table.schema.fields[0]?.type).toBeInstanceOf(List);
    expect(table.schema.fields[1]?.type).toBeInstanceOf(Struct);
    expect(table.schema.fields[2]?.type).toBeInstanceOf(Map_);
  });

  test("falls back from type_text to type_name when type_text missing", () => {
    const columns = [{ name: "id", type_name: "BIGINT" }];
    const buf = Buffer.from(buildEmptyArrowIPCBase64(columns), "base64");
    const table = tableFromIPC(buf);
    expect(
      (table.schema.fields[0]?.type as { bitWidth?: number }).bitWidth,
    ).toBe(64);
  });

  test("unknown type degrades to Utf8 without throwing", () => {
    const columns = [
      { name: "id", type_text: "BIGINT" },
      { name: "weird", type_text: "FUTURE_TYPE_NOT_YET_SUPPORTED" },
    ];
    const buf = Buffer.from(buildEmptyArrowIPCBase64(columns), "base64");
    const table = tableFromIPC(buf);
    expect(
      (table.schema.fields[0]?.type as { bitWidth?: number }).bitWidth,
    ).toBe(64);
    expect(table.schema.fields[1]?.type).toBeInstanceOf(Utf8);
  });

  test("missing column name gets a synthesized placeholder", () => {
    const columns = [{ type_text: "STRING" }, { name: "", type_text: "INT" }];
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
