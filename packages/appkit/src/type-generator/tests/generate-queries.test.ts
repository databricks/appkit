import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readdir: vi.fn(),
  readFile: vi.fn(),
  executeStatement: vi.fn(),
  spinnerStop: vi.fn(),
  spinnerPrintDetail: vi.fn(),
  loadCache: vi.fn(() => ({ version: "2", queries: {} })),
  saveCache: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  default: {
    readdir: mocks.readdir,
    readFile: mocks.readFile,
  },
}));

vi.mock("@databricks/sdk-experimental", () => ({
  WorkspaceClient: vi.fn(() => ({
    statementExecution: { executeStatement: mocks.executeStatement },
  })),
}));

vi.mock("../spinner", () => ({
  Spinner: vi.fn(() => ({
    start: vi.fn(),
    update: vi.fn(),
    stop: mocks.spinnerStop,
    printDetail: mocks.spinnerPrintDetail,
  })),
}));

vi.mock("../cache", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, loadCache: mocks.loadCache, saveCache: mocks.saveCache };
});

const { generateQueriesFromDescribe } = await import("../query-registry");

function succeededResult(columns: [string, string, string | null][]) {
  return {
    statement_id: "stmt-1",
    status: { state: "SUCCEEDED" },
    result: { data_array: columns },
  };
}

describe("generateQueriesFromDescribe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("success path — returns query schema", async () => {
    mocks.readdir.mockResolvedValue(["users.sql"]);
    mocks.readFile.mockResolvedValue(
      "SELECT id, name FROM users WHERE status = :status",
    );
    mocks.executeStatement.mockResolvedValue(
      succeededResult([
        ["id", "INT", null],
        ["name", "STRING", null],
      ]),
    );

    const schemas = await generateQueriesFromDescribe("/queries", "wh-123");

    expect(schemas).toHaveLength(1);
    expect(schemas[0].name).toBe("users");
    expect(schemas[0].type).toContain("id: number");
    expect(schemas[0].type).toContain("name: string");
    expect(mocks.spinnerStop).toHaveBeenCalledWith("");
    expect(mocks.saveCache).toHaveBeenCalledTimes(1);
  });

  test("FAILED status with error message — reports SQL error and produces unknown result type", async () => {
    mocks.readdir.mockResolvedValue(["bad_table.sql"]);
    mocks.readFile.mockResolvedValue("SELECT * FROM bad_table");
    mocks.executeStatement.mockResolvedValue({
      statement_id: "stmt-2",
      status: {
        state: "FAILED",
        error: { message: "Table or view not found: bad_table" },
      },
    });

    const schemas = await generateQueriesFromDescribe("/queries", "wh-123");

    expect(schemas).toHaveLength(1);
    expect(schemas[0].name).toBe("bad_table");
    expect(schemas[0].type).toContain("result: unknown");
    expect(mocks.spinnerStop).toHaveBeenCalledWith("");
    expect(mocks.saveCache).toHaveBeenCalledTimes(1);
  });

  test("FAILED status without error message — uses fallback message and produces unknown result type", async () => {
    mocks.readdir.mockResolvedValue(["query.sql"]);
    mocks.readFile.mockResolvedValue("SELECT 1");
    mocks.executeStatement.mockResolvedValue({
      statement_id: "stmt-3",
      status: { state: "FAILED" },
    });

    const schemas = await generateQueriesFromDescribe("/queries", "wh-123");

    expect(schemas).toHaveLength(1);
    expect(schemas[0].name).toBe("query");
    expect(schemas[0].type).toContain("result: unknown");
    expect(mocks.spinnerStop).toHaveBeenCalledWith("");
    expect(mocks.saveCache).toHaveBeenCalledTimes(1);
  });

  test("partial failure — caches success, unknown result for failure, output includes both", async () => {
    mocks.readdir.mockResolvedValue(["good.sql", "bad.sql"]);
    mocks.readFile
      .mockResolvedValueOnce("SELECT id FROM good_table WHERE status = :status")
      .mockResolvedValueOnce("SELECT * FROM missing_table");

    mocks.executeStatement
      .mockResolvedValueOnce(succeededResult([["id", "INT", null]]))
      .mockResolvedValueOnce({
        statement_id: "stmt-fail",
        status: {
          state: "FAILED",
          error: { message: "Table not found" },
        },
      });

    const schemas = await generateQueriesFromDescribe("/queries", "wh-123");

    expect(schemas).toHaveLength(2);

    // success entry is fully typed
    expect(schemas[0].name).toBe("good");
    expect(schemas[0].type).toContain("id: number");

    // failure entry is unknown result with unknown result
    expect(schemas[1].name).toBe("bad");
    expect(schemas[1].type).toContain("result: unknown");

    // saveCache called once after all parallel queries complete
    expect(mocks.saveCache).toHaveBeenCalledTimes(1);
  });

  test("all queries fail — caches with retry flag, all unknown result types", async () => {
    mocks.readdir.mockResolvedValue(["a.sql", "b.sql"]);
    mocks.readFile
      .mockResolvedValueOnce("SELECT * FROM table_a")
      .mockResolvedValueOnce("SELECT * FROM table_b");

    mocks.executeStatement
      .mockRejectedValueOnce(new Error("Connection refused"))
      .mockResolvedValueOnce({
        statement_id: "stmt-fail-2",
        status: { state: "FAILED", error: { message: "Table not found" } },
      });

    const schemas = await generateQueriesFromDescribe("/queries", "wh-123");

    expect(schemas).toHaveLength(2);
    expect(schemas[0].name).toBe("a");
    expect(schemas[0].type).toContain("result: unknown");
    expect(schemas[1].name).toBe("b");
    expect(schemas[1].type).toContain("result: unknown");

    // saveCache called once after all parallel queries complete
    expect(mocks.saveCache).toHaveBeenCalledTimes(1);
  });

  test("concurrency batching — saves cache after each batch", async () => {
    // 3 queries with concurrency=2 → 2 batches (2 + 1), saveCache called twice
    mocks.readdir.mockResolvedValue(["q1.sql", "q2.sql", "q3.sql"]);
    mocks.readFile
      .mockResolvedValueOnce("SELECT id FROM t1")
      .mockResolvedValueOnce("SELECT id FROM t2")
      .mockResolvedValueOnce("SELECT id FROM t3");

    mocks.executeStatement
      .mockResolvedValueOnce(succeededResult([["id", "INT", null]]))
      .mockResolvedValueOnce(succeededResult([["id", "INT", null]]))
      .mockResolvedValueOnce(succeededResult([["id", "INT", null]]));

    const schemas = await generateQueriesFromDescribe("/queries", "wh-123", {
      concurrency: 2,
    });

    expect(schemas).toHaveLength(3);
    expect(schemas[0].name).toBe("q1");
    expect(schemas[1].name).toBe("q2");
    expect(schemas[2].name).toBe("q3");

    // 2 batches → 2 saveCache calls
    expect(mocks.saveCache).toHaveBeenCalledTimes(2);
  });

  test("unknown result type includes parameters from SQL", async () => {
    mocks.readdir.mockResolvedValue(["parameterized.sql"]);
    mocks.readFile.mockResolvedValue(
      "-- @param status STRING\nSELECT * FROM t WHERE status = :status AND org = :org",
    );
    mocks.executeStatement.mockRejectedValueOnce(new Error("timeout"));

    const schemas = await generateQueriesFromDescribe("/queries", "wh-123");

    expect(schemas).toHaveLength(1);
    expect(schemas[0].type).toContain("status: SQLStringMarker");
    expect(schemas[0].type).toContain("org: SQLTypeMarker");
    expect(schemas[0].type).toContain("result: unknown");
  });
});
