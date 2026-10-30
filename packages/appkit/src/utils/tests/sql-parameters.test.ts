import { describe, expect, test } from "vitest";

import { QueryProcessor } from "../../plugins/analytics/query";
import { extractParameters } from "../sql-parameters";

describe("extractParameters", () => {
  test("colons inside a double-quoted literal aren't parameters", () => {
    expect(
      extractParameters(
        `SELECT date_format(ts, "yyyy-MM-dd'T'HH:mm:ss") AS t FROM trips WHERE day >= :start_date`,
      ),
    ).toEqual(["start_date"]);
  });

  test.each([
    ["single-quoted", `SELECT 'at 10:30' AS t, :a`],
    ["'' escape", `SELECT 'it''s 10:30' AS t, :a`],
    ["\\' escape", `SELECT 'it\\'s 10:30' AS t, :a`],
    ['"" escape', `SELECT "say ""hi"" at 10:30" AS t, :a`],
    ["backtick identifier", "SELECT `col:name` AS t, :a"],
    ["line comment", "SELECT 1 -- run at 10:30 :not_me\n, :a"],
    [":: cast", "SELECT x::int AS t, :a"],
  ])("%s", (_, sql) => {
    expect(extractParameters(sql)).toEqual(["a"]);
  });

  test("parameters next to literals still count", () => {
    expect(
      extractParameters(
        `SELECT * FROM t WHERE a = :a AND b = 'x:y' AND c = :c`,
      ),
    ).toEqual(["a", "c"]);
  });
});

describe("QueryProcessor with literals containing colons", () => {
  const processor = new QueryProcessor();
  const sql = `SELECT date_format(ts, "yyyy-MM-dd'T'HH:mm:ss") AS t FROM trips WHERE day >= :start_date`;

  test("only the real parameter is accepted", () => {
    expect(
      processor.convertToSQLParameters(sql, {
        start_date: { __sql_type: "DATE", value: "2026-01-01" },
      } as never).parameters,
    ).toHaveLength(1);
    expect(() =>
      processor.convertToSQLParameters(sql, {
        mm: { __sql_type: "STRING", value: "x" },
      } as never),
    ).toThrow(/valid: start_date/);
  });
});
