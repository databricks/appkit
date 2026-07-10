import { beforeEach, describe, expect, test, vi } from "vitest";

// Mock the connectors barrel so readEvalDataset uses a fake SQLWarehouseConnector.
const executeStatement = vi.fn();
vi.mock("../../connectors", () => ({
  SQLWarehouseConnector: class {
    executeStatement = executeStatement;
  },
}));

import { readEvalDataset } from "../dataset";

const client = {} as never;

describe("readEvalDataset", () => {
  beforeEach(() => {
    executeStatement.mockReset();
  });

  test("maps connector rows to {inputs, expectations}", async () => {
    executeStatement.mockResolvedValue({
      result: {
        data: [
          {
            inputs: { query: "What is MLflow?" },
            expectations: { expected_facts: ["MLflow is an ML platform"] },
          },
          { inputs: { query: "Weather?" }, expectations: null },
        ],
      },
    });

    const rows = await readEvalDataset(client, {
      table: "main.default.eval_ds",
      warehouseId: "wh1",
    });

    expect(rows).toEqual([
      {
        inputs: { query: "What is MLflow?" },
        expectations: { expected_facts: ["MLflow is an ML platform"] },
      },
      { inputs: { query: "Weather?" }, expectations: undefined },
    ]);

    // SELECT targets the table; no LIMIT when unset.
    const [, input] = executeStatement.mock.calls[0];
    expect(input.warehouse_id).toBe("wh1");
    expect(input.statement).toBe(
      "SELECT inputs, expectations FROM main.default.eval_ds",
    );
  });

  test("applies an integer LIMIT when provided", async () => {
    executeStatement.mockResolvedValue({ result: { data: [] } });
    await readEvalDataset(client, {
      table: "cat.sch.tbl",
      warehouseId: "wh1",
      limit: 5,
    });
    expect(executeStatement.mock.calls[0][1].statement).toBe(
      "SELECT inputs, expectations FROM cat.sch.tbl LIMIT 5",
    );
  });

  test("defaults a missing/non-object inputs cell to {}", async () => {
    executeStatement.mockResolvedValue({
      result: { data: [{ inputs: null }, { inputs: "oops" }] },
    });
    const rows = await readEvalDataset(client, {
      table: "cat.sch.tbl",
      warehouseId: "wh1",
    });
    expect(rows).toEqual([
      { inputs: {}, expectations: undefined },
      { inputs: {}, expectations: undefined },
    ]);
  });

  test("rejects a non-3-level table name without querying", async () => {
    await expect(
      readEvalDataset(client, { table: "schema.table", warehouseId: "wh1" }),
    ).rejects.toThrow(/catalog\.schema\.table/);
    await expect(
      readEvalDataset(client, {
        table: "cat.sch.tbl; DROP TABLE x",
        warehouseId: "wh1",
      }),
    ).rejects.toThrow(/Invalid dataset table/);
    expect(executeStatement).not.toHaveBeenCalled();
  });
});
