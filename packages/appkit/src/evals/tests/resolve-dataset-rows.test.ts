import { beforeEach, describe, expect, test, vi } from "vitest";

// Mock the connectors barrel so readEvalDataset (called by resolveDatasetRows)
// uses a fake SQLWarehouseConnector.
const executeStatement = vi.fn();
vi.mock("../../connectors", () => ({
  SQLWarehouseConnector: class {
    executeStatement = executeStatement;
  },
}));

import { defineEval } from "../define-eval";
import { resolveDatasetRows } from "../run-evals";
import type { RunEvalsOptions } from "../run-evals";

const options: RunEvalsOptions = {
  baseUrl: "http://localhost:3000",
  workspaceClient: {} as never,
  warehouseId: "wh1",
};

describe("resolveDatasetRows", () => {
  beforeEach(() => {
    executeStatement.mockReset();
  });

  test("surfaces an error when the dataset returns no rows", async () => {
    executeStatement.mockResolvedValue({ result: { data: [] } });
    const def = defineEval({
      dataset: { table: "main.default.empty_ds" },
      test: () => {},
    });

    const result = await resolveDatasetRows(def, options);

    expect(result.rows).toEqual([undefined]);
    expect(result.error).toBe(
      'dataset "main.default.empty_ds" returned no rows',
    );
  });

  test("returns the rows when the dataset is non-empty", async () => {
    executeStatement.mockResolvedValue({
      result: { data: [{ inputs: { q: "hi" }, expectations: null }] },
    });
    const def = defineEval({
      dataset: { table: "main.default.ds" },
      test: () => {},
    });

    const result = await resolveDatasetRows(def, options);

    expect(result.error).toBeUndefined();
    expect(result.rows).toEqual([
      { inputs: { q: "hi" }, expectations: undefined },
    ]);
  });
});
