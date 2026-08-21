import { Table, tableToIPC, Utf8, vectorFromArray } from "apache-arrow";
import { describe, expect, test } from "vitest";

import { ArrowClient } from "./arrow-client";

/** Build an Arrow IPC stream (2 cols, 2 rows) with the given field names. */
function ipc(names: [string, string]): Uint8Array {
  const table = new Table({
    [names[0]]: vectorFromArray(["a", "b"], new Utf8()),
    [names[1]]: vectorFromArray(["1", "2"], new Utf8()),
  });
  return tableToIPC(table, "stream");
}

describe("ArrowClient.processArrowBuffer column relabeling", () => {
  test("relabels positional col_N to the provided manifest names", async () => {
    const table = await ArrowClient.processArrowBuffer(
      ipc(["col_0", "col_1"]),
      ["name", "totalSpend"],
    );
    expect(table.schema.fields.map((f) => f.name)).toEqual([
      "name",
      "totalSpend",
    ]);
    // Data is preserved under the new names.
    expect(table.getChild("name")?.get(0)).toBe("a");
    expect(table.getChild("totalSpend")?.get(1)).toBe("2");
  });

  test("no-op when no names are provided", async () => {
    const table = await ArrowClient.processArrowBuffer(ipc(["col_0", "col_1"]));
    expect(table.schema.fields.map((f) => f.name)).toEqual(["col_0", "col_1"]);
  });

  test("no-op when the name count does not match", async () => {
    const table = await ArrowClient.processArrowBuffer(
      ipc(["col_0", "col_1"]),
      ["only_one"],
    );
    expect(table.schema.fields.map((f) => f.name)).toEqual(["col_0", "col_1"]);
  });

  test("ignores non-unique names rather than dropping a column", async () => {
    const table = await ArrowClient.processArrowBuffer(
      ipc(["col_0", "col_1"]),
      ["dup", "dup"],
    );
    expect(table.schema.fields.map((f) => f.name)).toEqual(["col_0", "col_1"]);
  });

  test("already-correct names are left as-is", async () => {
    const table = await ArrowClient.processArrowBuffer(
      ipc(["name", "totalSpend"]),
      ["name", "totalSpend"],
    );
    expect(table.schema.fields.map((f) => f.name)).toEqual([
      "name",
      "totalSpend",
    ]);
  });
});
