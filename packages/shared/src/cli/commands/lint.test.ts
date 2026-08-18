import { describe, expect, test } from "vitest";

import { lintSource } from "./lint";

const RULE = "ai-search-index-requires-columns";

/** Lint TS source, keeping only this rule's violations. */
function columnsViolations(code: string) {
  return lintSource(code, "server.ts").filter((v) => v.rule === RULE);
}

describe("ai-search-index-requires-columns", () => {
  test("passes an index with columns", () => {
    const code = `aiSearch({ indexes: { demo: { columns: ["id", "text"] } } });`;
    expect(columnsViolations(code)).toHaveLength(0);
  });

  test("flags an index missing columns", () => {
    const code = `aiSearch({ indexes: { demo: { queryType: "hybrid" } } });`;
    const v = columnsViolations(code);
    expect(v).toHaveLength(1);
    expect(v[0].code).toContain("demo");
  });

  test("flags an index with an empty columns array", () => {
    const code = `aiSearch({ indexes: { demo: { columns: [] } } });`;
    expect(columnsViolations(code)).toHaveLength(1);
  });

  test("flags an empty array with whitespace", () => {
    const code = `aiSearch({ indexes: { demo: { columns: [ ] } } });`;
    expect(columnsViolations(code)).toHaveLength(1);
  });

  test("flags bare aiSearch() — relies on the columnless env default index", () => {
    expect(columnsViolations("aiSearch();")).toHaveLength(1);
  });

  test("flags aiSearch({}) with no indexes key", () => {
    expect(columnsViolations("aiSearch({});")).toHaveLength(1);
  });

  test("flags aiSearch({ indexes: {} }) with no configured index", () => {
    expect(columnsViolations("aiSearch({ indexes: {} });")).toHaveLength(1);
  });

  test("flags only the index missing columns among several", () => {
    const code = `aiSearch({
      indexes: {
        ok: { columns: ["id"] },
        bad: { queryType: "hybrid" },
        alsoOk: { columns: ["title"] },
      },
    });`;
    const v = columnsViolations(code);
    expect(v).toHaveLength(1);
    expect(v[0].code).toContain("bad");
  });

  test("passes a columns reference to a constant (can't prove empty)", () => {
    const code = `aiSearch({ indexes: { demo: { columns: DEFAULT_COLUMNS } } });`;
    expect(columnsViolations(code)).toHaveLength(0);
  });

  test("passes a dynamically-built indexes object", () => {
    const code = `aiSearch({ indexes: buildIndexes() });`;
    expect(columnsViolations(code)).toHaveLength(0);
  });

  test("passes a spread index config (can't inspect)", () => {
    const code = `aiSearch({ indexes: { demo: { ...base } } });`;
    expect(columnsViolations(code)).toHaveLength(0);
  });

  test("passes a dynamic config argument", () => {
    expect(columnsViolations("aiSearch(myConfig);")).toHaveLength(0);
  });

  test("ignores a non-aiSearch call with the same shape", () => {
    const code = `genie({ indexes: { demo: { queryType: "hybrid" } } });`;
    expect(columnsViolations(code)).toHaveLength(0);
  });

  test("skipped on test files (includeTests: false)", () => {
    const code = `aiSearch();`;
    const testFileViolations = lintSource(code, "server.ts", undefined, true);
    expect(testFileViolations.some((v) => v.rule === RULE)).toBe(false);
  });
});
