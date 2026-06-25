import { tableFromArrays } from "apache-arrow";
import { describe, expect, test } from "vitest";
import { toRowObjects } from "../rows";

describe("toRowObjects", () => {
  test("returns the JSON array unchanged", () => {
    const data = [
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ];
    expect(toRowObjects(data)).toEqual(data);
  });

  test("empty / non-array JSON yields an empty list", () => {
    expect(toRowObjects([])).toEqual([]);
  });

  test("converts an Arrow table to row objects", () => {
    const table = tableFromArrays({
      city: ["NYC", "SF", "LA"],
      visits: [100, 200, 300],
    });

    const rows = toRowObjects(table);

    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ city: "NYC", visits: 100 });
    expect(rows[2]).toMatchObject({ city: "LA", visits: 300 });
  });

  test("coerces Arrow BigInt columns to numbers so Plotly can plot them", () => {
    const table = tableFromArrays({
      id: BigInt64Array.from([1n, 2n]),
    });

    const rows = toRowObjects(table);

    expect(typeof rows[0].id).toBe("number");
    expect(rows[0].id).toBe(1);
    expect(rows[1].id).toBe(2);
  });
});
