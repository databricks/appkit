import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
  executeStatement: vi.fn(),
  spinnerStop: vi.fn(),
  spinnerPrintDetail: vi.fn(),
  loadCache: vi.fn(() => ({ version: "1", queries: {} })),
  saveCache: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: {
    readdirSync: mocks.readdirSync,
    readFileSync: mocks.readFileSync,
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
    mocks.readdirSync.mockReturnValue(["users.sql"]);
    mocks.readFileSync.mockReturnValue(
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
    expect(mocks.spinnerStop).toHaveBeenCalledWith("✓ users");
  });

  test("FAILED status with error message — reports SQL error via spinner", async () => {
    mocks.readdirSync.mockReturnValue(["bad_table.sql"]);
    mocks.readFileSync.mockReturnValue("SELECT * FROM bad_table");
    mocks.executeStatement.mockResolvedValue({
      statement_id: "stmt-2",
      status: {
        state: "FAILED",
        error: { message: "Table or view not found: bad_table" },
      },
    });

    const schemas = await generateQueriesFromDescribe("/queries", "wh-123");

    expect(schemas).toHaveLength(0);
    expect(mocks.spinnerStop).toHaveBeenCalledWith("✗ bad_table - failed");
    expect(mocks.spinnerPrintDetail).toHaveBeenCalledWith(
      "SQL Error: Table or view not found: bad_table",
    );
    expect(mocks.spinnerPrintDetail).toHaveBeenCalledWith(
      expect.stringContaining("Query:"),
    );
  });

  test("FAILED status without error message — uses fallback message", async () => {
    mocks.readdirSync.mockReturnValue(["query.sql"]);
    mocks.readFileSync.mockReturnValue("SELECT 1");
    mocks.executeStatement.mockResolvedValue({
      statement_id: "stmt-3",
      status: { state: "FAILED" },
    });

    const schemas = await generateQueriesFromDescribe("/queries", "wh-123");

    expect(schemas).toHaveLength(0);
    expect(mocks.spinnerStop).toHaveBeenCalledWith("✗ query - failed");
    expect(mocks.spinnerPrintDetail).toHaveBeenCalledWith(
      "SQL Error: Query execution failed",
    );
  });
});
