import {
  Binary,
  Bool,
  type DataType,
  DateDay,
  Decimal,
  Float32,
  Float64,
  Int8,
  Int16,
  Int32,
  Int64,
  makeData,
  makeVector,
  Table,
  TimestampMicrosecond,
  tableFromIPC,
  tableToIPC,
  Utf8,
  type Vector,
  vectorFromArray,
} from "apache-arrow";
import { describe, expect, test } from "vitest";

import { formatJsonArrayCell, parseJsonArrayCell } from "../json-array-cells";

function decimalVector(unscaled: bigint[], scale: number, precision: number) {
  const words = new Uint32Array(unscaled.length * 4);
  unscaled.forEach((value, i) => {
    const bits = value < 0n ? (1n << 128n) + value : value;
    for (let w = 0; w < 4; w++) {
      words[i * 4 + w] = Number((bits >> BigInt(32 * w)) & 0xffffffffn);
    }
  });
  return makeVector(
    makeData({
      type: new Decimal(scale, precision, 128),
      length: unscaled.length,
      data: words,
    }),
  );
}

const DAY = 86_400_000;

const cases: Array<[string, () => Vector]> = [
  ["TINYINT", () => vectorFromArray([-128, -1, 0, 127], new Int8())],
  ["SMALLINT", () => vectorFromArray([-32768, 32767], new Int16())],
  ["INT", () => vectorFromArray([-2147483648, 0, 42, 2147483647], new Int32())],
  [
    "BIGINT",
    () =>
      vectorFromArray(
        [-9223372036854775808n, 0n, 9007199254740993n, 9223372036854775807n],
        new Int64(),
      ),
  ],
  ["FLOAT", () => vectorFromArray([0, -0.25, 0.1, 3.4e38], new Float32())],
  [
    "DOUBLE",
    () =>
      vectorFromArray(
        [0, 1.1, -1e-300, Number.MAX_VALUE, Number.NaN],
        new Float64(),
      ),
  ],
  [
    "DECIMAL(10,2)",
    () => decimalVector([-50n, 0n, 51n, 5n, 9999999999n, -9999999999n], 2, 10),
  ],
  ["DECIMAL(38,0)", () => decimalVector([10n ** 37n, -1n], 0, 38)],
  ["DECIMAL(5,5)", () => decimalVector([12345n, -1n], 5, 5)],
  [
    "DATE",
    () =>
      vectorFromArray(
        [-DAY, Date.UTC(2024, 1, 29), Date.UTC(2026, 0, 1)],
        new DateDay(),
      ),
  ],
  [
    "TIMESTAMP",
    () =>
      vectorFromArray(
        [
          0,
          Date.UTC(2026, 0, 1, 10, 0, 0, 123),
          Date.UTC(1969, 11, 31, 23, 59, 59, 999),
        ],
        new TimestampMicrosecond("UTC"),
      ),
  ],
  [
    "TIMESTAMP_NTZ",
    () =>
      vectorFromArray(
        [0, Date.UTC(2026, 0, 1, 10, 0, 0, 123)],
        new TimestampMicrosecond(),
      ),
  ],
  ["BOOLEAN", () => vectorFromArray([true, false], new Bool())],
  [
    "STRING",
    () => vectorFromArray(["", "a", "ünïcödé ✓", '{"x": 1}'], new Utf8()),
  ],
  [
    "BINARY",
    () =>
      vectorFromArray(
        [new Uint8Array([]), new Uint8Array([0, 255, 1])],
        new Binary(),
      ),
  ],
];

/** Values as an Arrow consumer reads them, comparable across decimal representations. */
const comparable = (value: unknown) =>
  value instanceof Uint8Array
    ? [...value]
    : typeof value === "object" || typeof value === "bigint"
      ? String(value)
      : value;

describe("JSON_ARRAY cell codecs", () => {
  test.each(cases)(
    "%s: parsing the formatted text gives back the native Arrow value",
    (_name, build) => {
      const table = tableFromIPC(
        tableToIPC(new Table({ c: build() }), "stream"),
      );
      const { type } = table.schema.fields[0];
      for (const native of table.getChildAt(0) ?? []) {
        const parsed = parseJsonArrayCell(
          formatJsonArrayCell(native, type),
          type,
        );
        expect(comparable(parsed)).toEqual(comparable(native));
      }
    },
  );

  test("formats match what a warehouse writes", () => {
    const formatted = (vector: Vector) => {
      const table = tableFromIPC(
        tableToIPC(new Table({ c: vector }), "stream"),
      );
      const { type } = table.schema.fields[0];
      return [...(table.getChildAt(0) ?? [])].map((v) =>
        formatJsonArrayCell(v, type),
      );
    };
    expect(formatted(decimalVector([-50n, 51n], 2, 10))).toEqual([
      "-0.50",
      "0.51",
    ]);
    expect(
      formatted(
        vectorFromArray([Date.UTC(2026, 0, 1, 10)], new TimestampMicrosecond()),
      ),
    ).toEqual(["2026-01-01T10:00:00.000"]);
    expect(
      formatted(vectorFromArray([Date.UTC(2026, 0, 1)], new DateDay())),
    ).toEqual(["2026-01-01"]);
  });

  test("a zoned TIMESTAMP keeps its instant when the warehouse writes the session offset", () => {
    const type = new TimestampMicrosecond("UTC");
    expect(parseJsonArrayCell("2026-01-01T10:00:00.000-08:00", type)).toBe(
      Date.UTC(2026, 0, 1, 18),
    );
  });

  test.each<[string, DataType, string]>([
    ["INT with a fraction", new Int32(), "1.5"],
    ["INT in exponent form", new Int32(), "1e3"],
    ["INT with padding", new Int32(), " 1"],
    ["INT out of range", new Int32(), "2147483648"],
    ["TINYINT out of range", new Int8(), "128"],
    ["empty BIGINT", new Int64(), ""],
    ["BIGINT with a fraction", new Int64(), "1.0"],
    ["BIGINT with a plus sign", new Int64(), "+1"],
    ["BIGINT with a leading zero", new Int64(), "01"],
    ["empty DOUBLE", new Float64(), ""],
    ["DOUBLE that is not a number", new Float64(), "abc"],
    [
      "DECIMAL with more digits than its scale",
      new Decimal(2, 10, 128),
      "1.234",
    ],
    ["DECIMAL with two points", new Decimal(2, 10, 128), "1.2.3"],
    ["DECIMAL with a plus sign", new Decimal(2, 10, 128), "+1.00"],
    [
      "DECIMAL with more digits than its precision",
      new Decimal(2, 5, 128),
      "123456789.00",
    ],
    ["BINARY that is not base64", new Binary(), "not base64!!"],
    ["DATE that is not on the calendar", new DateDay(), "2026-02-31"],
    ["DATE without zero padding", new DateDay(), "2026-1-1"],
    ["DATE with a time", new DateDay(), "2026-01-01T00:00:00Z"],
    [
      "zoned TIMESTAMP without an offset",
      new TimestampMicrosecond("UTC"),
      "2026-01-01T10:00:00.000",
    ],
    [
      "zoned TIMESTAMP that is not a date",
      new TimestampMicrosecond("UTC"),
      "2026-13-01T10:00:00Z",
    ],
    [
      "TIMESTAMP_NTZ that is not on the calendar",
      new TimestampMicrosecond(),
      "2026-02-30T10:00:00.000",
    ],
    [
      "TIMESTAMP_NTZ with Z",
      new TimestampMicrosecond(),
      "2026-01-01T10:00:00.000Z",
    ],
    [
      "TIMESTAMP_NTZ with an offset",
      new TimestampMicrosecond(),
      "2026-01-01T10:00:00.000-08:00",
    ],
    ["BOOLEAN in upper case", new Bool(), "TRUE"],
    ["BOOLEAN as a digit", new Bool(), "1"],
  ])("rejects %s", (_name, type, cell) => {
    expect(() => parseJsonArrayCell(cell, type)).toThrow(/Invalid/);
  });
});
