import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readdir: vi.fn(),
  readFile: vi.fn(),
  executeStatement: vi.fn(),
  // Warehouse preflight probe. Defaults to RUNNING so every existing describe
  // test takes the "proceed" path unchanged; override per-test to exercise
  // stopped/starting/unreachable preflight branches.
  getWarehouse: vi.fn(() => ({ state: "RUNNING" })),
  // warehouses.start — only the blocking startWaitProceed path calls this.
  startWarehouse: vi.fn(),
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
    warehouses: { get: mocks.getWarehouse, start: mocks.startWarehouse },
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
const { CACHE_VERSION, hashSQL } = await import("../cache");

// The default mode is "non-blocking", which never probes the warehouse and never
// describes. The bulk of these tests exercise the DESCRIBE / classify path, so
// they run in "blocking" mode (probe → proceed → describe) by default. Tests
// that specifically assert the non-blocking short-circuit pass an explicit mode.
function describeQueries(
  queryFolder: string,
  warehouseId: string,
  options: Parameters<typeof generateQueriesFromDescribe>[2] = {},
) {
  return generateQueriesFromDescribe(queryFolder, warehouseId, {
    mode: "blocking",
    ...options,
  });
}

// Sentinel for a previously-generated good type. The code passes cached types
// through verbatim, so equality proves reuse rather than regeneration.
const CACHED_GOOD_TYPE = "RESULT_REUSED_FROM_CACHE";

// The `queries` map of the cache object last handed to saveCache — i.e. what
// actually got persisted this run.
const lastSavedQueries = () =>
  (
    mocks.saveCache.mock.calls.at(-1)?.[0] as
      | { queries: Record<string, { type: string }> }
      | undefined
  )?.queries;

function succeededResult(columns: [string, string, string | null][]) {
  return {
    statement_id: "stmt-1",
    status: { state: "SUCCEEDED" },
    result: { data_array: columns },
  };
}

/**
 * Build a SUCCEEDED DESCRIBE QUERY response whose rows arrive only as a base64
 * Arrow IPC `attachment` (no `data_array`) — the ARROW_STREAM/INLINE wire shape
 * the fetcher now requests. The describeOne path pipes this through
 * normalizeResultRows, which decodes the attachment so convertToQueryType can
 * read the columns. Each [name, type, comment] triple becomes one DESCRIBE row.
 */
async function succeededArrowAttachmentResult(
  columns: [string, string, string | null][],
) {
  const arrow = await import("apache-arrow");
  const table = arrow.tableFromArrays({
    col_name: columns.map((c) => c[0]),
    data_type: columns.map((c) => c[1]),
    comment: columns.map((c) => c[2]),
  });
  const attachment = Buffer.from(arrow.tableToIPC(table, "stream")).toString(
    "base64",
  );
  return {
    statement_id: "stmt-arrow",
    status: { state: "SUCCEEDED" },
    manifest: { format: "ARROW_STREAM" },
    // No data_array — rows live in the attachment, like a real INLINE Arrow
    // response. This is the condition the silent-degrade bug left unread.
    result: { attachment },
  };
}

describe("generateQueriesFromDescribe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-establish the RUNNING default so a per-test preflight override (e.g.
    // mockReturnValue/mockImplementation) never leaks into the next test.
    mocks.getWarehouse.mockReturnValue({ state: "RUNNING" });
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

    const { schemas, syntaxErrors, fatalErrors } = await describeQueries(
      "/queries",
      "wh-123",
    );

    expect(schemas).toHaveLength(1);
    expect(schemas[0].name).toBe("users");
    expect(schemas[0].type).toContain("id: number");
    expect(schemas[0].type).toContain("name: string");
    expect(mocks.spinnerStop).toHaveBeenCalledWith("");
    expect(mocks.saveCache).toHaveBeenCalledTimes(1);
    // clean success: cached, and not flagged as a syntax error
    expect(syntaxErrors).toEqual([]);
    expect(fatalErrors).toEqual([]);
    expect(lastSavedQueries()?.users.type).toContain("id: number");
  });

  test("ARROW attachment path — decodes Arrow rows into a real query schema", async () => {
    // The warehouse answers ARROW_STREAM/INLINE: columns arrive only as a
    // base64 Arrow IPC attachment with data_array undefined. describeOne pipes
    // this through normalizeResultRows before convertToQueryType, so the schema
    // resolves to real columns instead of the degraded `result: unknown`.
    mocks.readdir.mockResolvedValue(["users.sql"]);
    mocks.readFile.mockResolvedValue(
      "SELECT id, name FROM users WHERE status = :status",
    );
    mocks.executeStatement.mockResolvedValue(
      await succeededArrowAttachmentResult([
        ["id", "INT", null],
        ["name", "STRING", "display name"],
      ]),
    );

    const { schemas, syntaxErrors, fatalErrors } = await describeQueries(
      "/queries",
      "wh-123",
    );

    expect(schemas).toHaveLength(1);
    expect(schemas[0].name).toBe("users");
    // Real columns recovered from the Arrow attachment — not `result: unknown`.
    expect(schemas[0].type).toContain("id: number");
    expect(schemas[0].type).toContain("name: string");
    expect(schemas[0].type).not.toContain("result: unknown");
    expect(syntaxErrors).toEqual([]);
    expect(fatalErrors).toEqual([]);
    // A resolved schema is cached (we only persist non-unknown results).
    expect(lastSavedQueries()?.users.type).toContain("id: number");
  });

  test("DESCRIBE request — tries JSON_ARRAY/INLINE first with a 30s wait", async () => {
    // Regression guard for the executeStatement call shape: the pinned
    // wait_timeout stops a PENDING return from degrading, and JSON_ARRAY is the
    // format standard DBSQL accepts — describeAdaptive only falls back to
    // ARROW_STREAM if the warehouse rejects JSON_ARRAY.
    mocks.readdir.mockResolvedValue(["q.sql"]);
    mocks.readFile.mockResolvedValue("SELECT 1 AS one");
    mocks.executeStatement.mockResolvedValue(
      succeededResult([["one", "INT", null]]),
    );

    await describeQueries("/queries", "wh-123");

    expect(mocks.executeStatement).toHaveBeenCalledTimes(1);
    expect(mocks.executeStatement.mock.calls[0][0]).toMatchObject({
      warehouse_id: "wh-123",
      wait_timeout: "30s",
      format: "JSON_ARRAY",
      disposition: "INLINE",
    });
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

    const { schemas } = await describeQueries("/queries", "wh-123");

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

    const { schemas } = await describeQueries("/queries", "wh-123");

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

    const { schemas } = await describeQueries("/queries", "wh-123");

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

  test("all queries fail (connectivity + syntax) — all produce unknown result types", async () => {
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

    const { schemas, syntaxErrors, fatalErrors } = await describeQueries(
      "/queries",
      "wh-123",
    );

    expect(schemas).toHaveLength(2);
    expect(schemas[0].name).toBe("a");
    expect(schemas[0].type).toContain("result: unknown");
    expect(schemas[1].name).toBe("b");
    expect(schemas[1].type).toContain("result: unknown");

    // saveCache called once after all parallel queries complete
    expect(mocks.saveCache).toHaveBeenCalledTimes(1);
    // a = connectivity (rejected) → NOT a syntax error; b = FAILED → syntax error
    expect(syntaxErrors).toEqual([{ name: "b", message: "Table not found" }]);
    // neither a connectivity failure nor a SQL error is classified as fatal
    expect(fatalErrors).toEqual([]);
    // neither failure is persisted to the cache
    expect(lastSavedQueries()).not.toHaveProperty("a");
    expect(lastSavedQueries()).not.toHaveProperty("b");
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

    const { schemas } = await describeQueries("/queries", "wh-123", {
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
    mocks.executeStatement.mockRejectedValueOnce(
      Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }),
    );

    const { schemas } = await describeQueries("/queries", "wh-123");

    expect(schemas).toHaveLength(1);
    expect(schemas[0].type).toContain("status: SQLStringMarker");
    expect(schemas[0].type).toContain("org: SQLTypeMarker");
    expect(schemas[0].type).toContain("result: unknown");
  });

  test("connectivity failure with stale cache emits unknown for the current SQL", async () => {
    const sql = "SELECT id FROM users";
    mocks.readdir.mockResolvedValue(["users.sql"]);
    mocks.readFile.mockResolvedValue(sql);
    // A prior good type cached under a STALE hash: the query is a cache MISS
    // (so DESCRIBE is attempted). If the warehouse is unreachable, do not
    // publish the stale result columns for different SQL text.
    mocks.loadCache.mockReturnValueOnce({
      version: CACHE_VERSION,
      queries: {
        users: { hash: "stale-hash", type: CACHED_GOOD_TYPE, retry: false },
      },
    });
    mocks.executeStatement.mockRejectedValueOnce(
      Object.assign(new Error("connect ECONNREFUSED"), {
        code: "ECONNREFUSED",
      }),
    );

    const { schemas, syntaxErrors, fatalErrors } = await describeQueries(
      "/queries",
      "wh-123",
    );

    expect(schemas[0].type).not.toBe(CACHED_GOOD_TYPE);
    expect(schemas[0].type).toContain("result: unknown");
    // connectivity is never recorded as a syntax error
    expect(syntaxErrors).toEqual([]);
    expect(fatalErrors).toEqual([]);
    // the existing good entry is left intact (not overwritten with unknown)
    expect(lastSavedQueries()?.users).toEqual({
      hash: "stale-hash",
      type: CACHED_GOOD_TYPE,
      retry: false,
    });
  });

  test("fatal rejected DESCRIBE request is not downgraded to offline", async () => {
    mocks.readdir.mockResolvedValue(["users.sql"]);
    mocks.readFile.mockResolvedValue("SELECT id FROM users");
    mocks.executeStatement.mockRejectedValueOnce(
      new Error("PERMISSION_DENIED: missing warehouse permission"),
    );

    const { schemas, fatalErrors } = await describeQueries(
      "/queries",
      "wh-123",
    );

    expect(schemas[0].type).toContain("result: unknown");
    expect(fatalErrors).toEqual([
      {
        name: "users",
        message: "PERMISSION_DENIED: missing warehouse permission",
      },
    ]);
    expect(mocks.saveCache).toHaveBeenCalledTimes(1);
    expect(lastSavedQueries()).not.toHaveProperty("users");
  });

  test("HTTP 503 wrapper error is classified as connectivity", async () => {
    mocks.readdir.mockResolvedValue(["users.sql"]);
    mocks.readFile.mockResolvedValue("SELECT id FROM users");
    mocks.executeStatement.mockRejectedValueOnce(
      Object.assign(new Error("Service unavailable"), { statusCode: 503 }),
    );

    const { schemas, fatalErrors } = await describeQueries(
      "/queries",
      "wh-123",
    );

    expect(schemas[0].type).toContain("result: unknown");
    expect(fatalErrors).toEqual([]);
  });

  test.each([
    ["HTTP 502", Object.assign(new Error("Bad gateway"), { status: 502 })],
    [
      "HTTP 504 response",
      Object.assign(new Error("Gateway timeout"), {
        response: { status: 504 },
      }),
    ],
    [
      "EAI_NODATA",
      Object.assign(new Error("DNS lookup failed"), { code: "EAI_NODATA" }),
    ],
    [
      "Envoy upstream disconnect",
      new Error("upstream connect error or disconnect/reset before headers"),
    ],
  ])("%s is classified as connectivity", async (_name, error) => {
    mocks.readdir.mockResolvedValue(["users.sql"]);
    mocks.readFile.mockResolvedValue("SELECT id FROM users");
    mocks.executeStatement.mockRejectedValueOnce(error);

    const { schemas, fatalErrors } = await describeQueries(
      "/queries",
      "wh-123",
    );

    expect(schemas[0].type).toContain("result: unknown");
    expect(fatalErrors).toEqual([]);
  });

  test("mixed syntax and fatal failures are both returned", async () => {
    mocks.readdir.mockResolvedValue(["syntax.sql", "fatal.sql"]);
    mocks.readFile
      .mockResolvedValueOnce("SELECT * FROM missing")
      .mockResolvedValueOnce("SELECT * FROM auth_blocked");
    mocks.executeStatement
      .mockResolvedValueOnce({
        statement_id: "stmt-syntax",
        status: {
          state: "FAILED",
          error: { message: "Table not found" },
        },
      })
      .mockRejectedValueOnce(new Error("PERMISSION_DENIED"));

    const { schemas, syntaxErrors, fatalErrors } = await describeQueries(
      "/queries",
      "wh-123",
    );

    expect(schemas).toHaveLength(2);
    expect(syntaxErrors).toEqual([
      { name: "syntax", message: "Table not found" },
    ]);
    expect(fatalErrors).toEqual([
      { name: "fatal", message: "PERMISSION_DENIED" },
    ]);
  });

  test("undici cause code is classified as connectivity even when wrapper message is generic fetch failed", async () => {
    mocks.readdir.mockResolvedValue(["users.sql"]);
    mocks.readFile.mockResolvedValue("SELECT id FROM users");
    mocks.executeStatement.mockRejectedValueOnce(
      Object.assign(new TypeError("fetch failed"), {
        cause: { code: "UND_ERR_CONNECT_TIMEOUT" },
      }),
    );

    const { schemas, fatalErrors } = await describeQueries(
      "/queries",
      "wh-123",
    );

    expect(schemas[0].type).toContain("result: unknown");
    expect(fatalErrors).toEqual([]);
  });

  test("SDK DNS wrapper (Can't connect to ..., code 500) is classified as connectivity", async () => {
    mocks.readdir.mockResolvedValue(["users.sql"]);
    mocks.readFile.mockResolvedValue("SELECT id FROM users");
    mocks.executeStatement.mockRejectedValueOnce(
      Object.assign(
        new Error(
          "Can't connect to https://x.cloud.databricks.com/api/2.0/sql/statements",
        ),
        { code: 500 },
      ),
    );

    const { schemas, fatalErrors } = await describeQueries(
      "/queries",
      "wh-123",
    );

    expect(schemas[0].type).toContain("result: unknown");
    expect(fatalErrors).toEqual([]);
  });

  test("TLS certificate message is classified as connectivity", async () => {
    mocks.readdir.mockResolvedValue(["users.sql"]);
    mocks.readFile.mockResolvedValue("SELECT id FROM users");
    mocks.executeStatement.mockRejectedValueOnce(
      new Error("unable to verify the first certificate"),
    );

    const { fatalErrors } = await describeQueries("/queries", "wh-123");

    expect(fatalErrors).toEqual([]);
  });

  test("bare timeout and fetch failed messages are not overmatched as connectivity", async () => {
    mocks.readdir.mockResolvedValue(["timeout.sql", "oauth.sql"]);
    mocks.readFile
      .mockResolvedValueOnce("SELECT id FROM timeout")
      .mockResolvedValueOnce("SELECT id FROM oauth");
    mocks.executeStatement
      .mockRejectedValueOnce(
        new Error("INVALID_PARAMETER_VALUE: timeout must be > 0"),
      )
      .mockRejectedValueOnce(
        Object.assign(new TypeError("fetch failed"), {
          cause: { code: "EXPIRED_OAUTH_TOKEN", message: "token expired" },
        }),
      );

    const { schemas, fatalErrors } = await describeQueries(
      "/queries",
      "wh-123",
    );

    expect(schemas).toHaveLength(2);
    expect(fatalErrors).toEqual([
      {
        name: "timeout",
        message: "INVALID_PARAMETER_VALUE: timeout must be > 0",
      },
      {
        name: "oauth",
        message: "fetch failed: token expired: EXPIRED_OAUTH_TOKEN",
      },
    ]);
  });

  test("successful describes in a fatal batch are saved", async () => {
    mocks.readdir.mockResolvedValue(["good.sql", "bad_auth.sql"]);
    mocks.readFile
      .mockResolvedValueOnce("SELECT id FROM good")
      .mockResolvedValueOnce("SELECT id FROM bad_auth");
    mocks.executeStatement
      .mockResolvedValueOnce(succeededResult([["id", "INT", null]]))
      .mockRejectedValueOnce(new Error("PERMISSION_DENIED"));

    const { schemas, fatalErrors } = await describeQueries(
      "/queries",
      "wh-123",
    );

    expect(schemas[0].type).toContain("id: number");
    expect(schemas[1].type).toContain("result: unknown");
    expect(fatalErrors).toEqual([
      { name: "bad_auth", message: "PERMISSION_DENIED" },
    ]);
    expect(lastSavedQueries()?.good.type).toContain("id: number");
    expect(lastSavedQueries()).not.toHaveProperty("bad_auth");
  });

  test("empty result (described, no columns) is unknown, not a syntax error, not cached", async () => {
    mocks.readdir.mockResolvedValue(["empty.sql"]);
    mocks.readFile.mockResolvedValue("SELECT 1");
    mocks.executeStatement.mockResolvedValue(succeededResult([]));

    const { schemas, syntaxErrors } = await describeQueries(
      "/queries",
      "wh-123",
    );

    expect(schemas[0].type).toContain("result: unknown");
    expect(syntaxErrors).toEqual([]);
    expect(lastSavedQueries()).not.toHaveProperty("empty");
  });

  test("PENDING (non-terminal, warehouse not ready) degrades to unknown, not empty, not cached", async () => {
    mocks.readdir.mockResolvedValue(["users.sql"]);
    mocks.readFile.mockResolvedValue("SELECT id FROM users");
    // Warehouse stopped/cold-starting: hybrid DESCRIBE returns a non-terminal
    // state with no result rows. Must degrade like a transient outage, not be
    // misreported as EMPTY (which would discard a good cached type).
    mocks.executeStatement.mockResolvedValue({
      statement_id: "stmt-1",
      status: { state: "PENDING" },
    });

    const { schemas, syntaxErrors, fatalErrors } = await describeQueries(
      "/queries",
      "wh-123",
    );

    expect(schemas).toHaveLength(1);
    expect(schemas[0].name).toBe("users");
    expect(schemas[0].type).toContain("result: unknown");
    expect(syntaxErrors).toEqual([]);
    expect(fatalErrors).toEqual([]);
    // a non-ready warehouse must never persist `result: unknown`
    expect(lastSavedQueries()).not.toHaveProperty("users");
  });

  test("PENDING reuses a prior good cached type when the SQL hash matches", async () => {
    // `users.sql` and `users.obo.sql` normalize to the same query name and hold
    // identical SQL (same hash). With concurrency=1 the first DESCRIBE SUCCEEDS
    // and its batch commits a good cached type; the second batch comes back
    // non-terminal (warehouse not ready) and must reuse that freshly-cached good
    // type rather than overwrite it with unknown.
    const sql = "SELECT id FROM users";
    mocks.readdir.mockResolvedValue(["users.sql", "users.obo.sql"]);
    mocks.readFile.mockResolvedValue(sql);
    mocks.executeStatement
      .mockResolvedValueOnce(succeededResult([["id", "INT", null]]))
      .mockResolvedValueOnce({
        statement_id: "stmt-pending",
        status: { state: "RUNNING" },
      });

    const { schemas, syntaxErrors, fatalErrors } = await describeQueries(
      "/queries",
      "wh-123",
      {
        concurrency: 1,
      },
    );

    expect(schemas).toHaveLength(2);
    // both entries resolve to the good type — the PENDING one reuses the cache
    expect(schemas[0].type).toContain("id: number");
    expect(schemas[1].type).toContain("id: number");
    expect(schemas[1].type).not.toContain("result: unknown");
    expect(syntaxErrors).toEqual([]);
    expect(fatalErrors).toEqual([]);
    // the good cached type persists; PENDING never overwrites it with unknown
    expect(lastSavedQueries()?.users.type).toContain("id: number");
  });

  test("syntax error (FAILED) is recorded in syntaxErrors and not cached", async () => {
    mocks.readdir.mockResolvedValue(["broken.sql"]);
    mocks.readFile.mockResolvedValue("SELECT * FROM missing");
    mocks.executeStatement.mockResolvedValue({
      statement_id: "stmt",
      status: {
        state: "FAILED",
        error: { message: "Table or view not found: missing" },
      },
    });

    const { schemas, syntaxErrors } = await describeQueries(
      "/queries",
      "wh-123",
    );

    expect(schemas[0].type).toContain("result: unknown");
    expect(syntaxErrors).toEqual([
      { name: "broken", message: "Table or view not found: missing" },
    ]);
    expect(lastSavedQueries()).not.toHaveProperty("broken");
  });

  test("cache HIT serves the stored type without calling the warehouse", async () => {
    const sql = "SELECT id FROM t";
    mocks.readdir.mockResolvedValue(["t.sql"]);
    mocks.readFile.mockResolvedValue(sql);
    mocks.loadCache.mockReturnValueOnce({
      version: CACHE_VERSION,
      queries: {
        t: { hash: hashSQL(sql), type: CACHED_GOOD_TYPE, retry: false },
      },
    });

    const { schemas, syntaxErrors } = await describeQueries(
      "/queries",
      "wh-123",
    );

    expect(mocks.executeStatement).not.toHaveBeenCalled();
    expect(schemas[0].type).toBe(CACHED_GOOD_TYPE);
    expect(syntaxErrors).toEqual([]);
  });

  test("stale retry-flagged cache entry is re-described, not reused", async () => {
    const sql = "SELECT id FROM t";
    mocks.readdir.mockResolvedValue(["t.sql"]);
    mocks.readFile.mockResolvedValue(sql);
    // Matching hash but retry:true (legacy poisoned entry) → must NOT be a HIT.
    mocks.loadCache.mockReturnValueOnce({
      version: CACHE_VERSION,
      queries: {
        t: { hash: hashSQL(sql), type: "STALE_UNKNOWN", retry: true },
      },
    });
    mocks.executeStatement.mockResolvedValue(
      succeededResult([["id", "INT", null]]),
    );

    const { schemas } = await describeQueries("/queries", "wh-123");

    expect(mocks.executeStatement).toHaveBeenCalledTimes(1);
    expect(schemas[0].type).toContain("id: number");
    expect(schemas[0].type).not.toBe("STALE_UNKNOWN");
  });

  describe("warehouse preflight", () => {
    test("STOPPED + blocking mode — starts the warehouse, waits for RUNNING, then describes", async () => {
      vi.useFakeTimers();
      try {
        mocks.readdir.mockResolvedValue(["a.sql"]);
        mocks.readFile.mockResolvedValue("SELECT id FROM a");
        // Preflight sees STOPPED (→ startWaitProceed): warehouses.start fires,
        // then waitUntilRunning polls the stale STOPPED once more before RUNNING.
        // After RUNNING, DESCRIBE runs normally.
        mocks.getWarehouse
          .mockReturnValueOnce({ state: "STOPPED" })
          .mockReturnValueOnce({ state: "STOPPED" })
          .mockReturnValue({ state: "RUNNING" });
        mocks.executeStatement.mockResolvedValue(
          succeededResult([["id", "INT", null]]),
        );

        const promise = generateQueriesFromDescribe("/queries", "wh-123", {
          mode: "blocking",
        });
        // Drive the wait loop's backoff sleep(s) so it can re-poll and observe
        // RUNNING. Run pending timers until the work settles.
        await vi.runAllTimersAsync();
        const { schemas, syntaxErrors, fatalErrors } = await promise;

        // The stopped warehouse was started, then described once it came up.
        expect(mocks.startWarehouse).toHaveBeenCalledTimes(1);
        expect(mocks.startWarehouse).toHaveBeenCalledWith({ id: "wh-123" });
        expect(mocks.executeStatement).toHaveBeenCalledTimes(1);
        expect(schemas).toHaveLength(1);
        expect(schemas[0].name).toBe("a");
        expect(schemas[0].type).toContain("id: number");
        expect(syntaxErrors).toEqual([]);
        expect(fatalErrors).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    test.each(["DELETED", "DELETING"] as const)(
      "%s + blocking mode — environmental, degrades silently, hadEnvironmentalFailure set for gate",
      async (state) => {
        // DELETED/DELETING are environmental (state-based fatals). They degrade
        // silently (fatalErrors empty) but set hadEnvironmentalFailure for the
        // entry point's has-types gate to handle.
        mocks.readdir.mockResolvedValue(["a.sql", "b.sql"]);
        mocks.readFile
          .mockResolvedValueOnce("SELECT id FROM a")
          .mockResolvedValueOnce("SELECT id FROM b");
        mocks.getWarehouse.mockReturnValue({ state });

        const { schemas, syntaxErrors, fatalErrors, hadEnvironmentalFailure } =
          await generateQueriesFromDescribe("/queries", "wh-123", {
            mode: "blocking",
          });

        // Environmental failures degrade, not fatal at query level.
        expect(mocks.startWarehouse).not.toHaveBeenCalled();
        expect(mocks.executeStatement).not.toHaveBeenCalled();
        expect(fatalErrors).toEqual([]); // environmental, not fatal
        expect(hadEnvironmentalFailure).toBe(true); // tracked for the gate
        expect(syntaxErrors).toEqual([]);
        // Schemas are still produced (degraded) so the .d.ts is written before
        // generateFromEntryPoint uses the gate to decide throw/warn.
        expect(schemas).toHaveLength(2);
        expect(schemas[0].type).toContain("result: unknown");
        expect(schemas[1].type).toContain("result: unknown");
      },
    );

    test("STOPPED + blocking — start succeeds but warehouse never reaches RUNNING is environmental, degrades silently", async () => {
      // A wait timeout (non-RUNNING resolve) is environmental (state-based
      // fatal). It degrades silently (fatalErrors empty) but sets
      // hadEnvironmentalFailure for the gate.
      vi.useFakeTimers();
      try {
        mocks.readdir.mockResolvedValue(["a.sql"]);
        mocks.readFile.mockResolvedValue("SELECT id FROM a");
        // Preflight sees STOPPED → start fires, but the warehouse then reports
        // DELETED (a genuinely terminal state even with treatStoppedAsTransient).
        // The wait resolves non-RUNNING → environmental; schemas still written.
        mocks.getWarehouse
          .mockReturnValueOnce({ state: "STOPPED" })
          .mockReturnValue({ state: "DELETED" });

        const promise = generateQueriesFromDescribe("/queries", "wh-123", {
          mode: "blocking",
        });
        await vi.runAllTimersAsync();
        const { schemas, syntaxErrors, fatalErrors, hadEnvironmentalFailure } =
          await promise;

        expect(mocks.startWarehouse).toHaveBeenCalledTimes(1);
        expect(mocks.executeStatement).not.toHaveBeenCalled();
        expect(syntaxErrors).toEqual([]);
        expect(fatalErrors).toEqual([]); // environmental, not fatal
        expect(hadEnvironmentalFailure).toBe(true); // tracked for the gate
        expect(schemas[0].type).toContain("result: unknown");
      } finally {
        vi.useRealTimers();
      }
    });

    test("non-blocking mode — degrades silently without probing, even when STOPPED", async () => {
      mocks.readdir.mockResolvedValue(["a.sql"]);
      mocks.readFile.mockResolvedValue("SELECT id FROM a");
      // Even a STOPPED warehouse is irrelevant: non-blocking never probes.
      mocks.getWarehouse.mockReturnValue({ state: "STOPPED" });

      const { schemas, syntaxErrors, fatalErrors } =
        await generateQueriesFromDescribe("/queries", "wh-123", {
          mode: "non-blocking",
        });

      // ZERO warehouse round-trips: no probe (getWarehouse) and no DESCRIBE.
      expect(mocks.getWarehouse).not.toHaveBeenCalled();
      expect(mocks.executeStatement).not.toHaveBeenCalled();
      expect(fatalErrors).toEqual([]);
      expect(syntaxErrors).toEqual([]);
      expect(schemas[0].type).toContain("result: unknown");
      // degraded, never a fatal failure
      expect(lastSavedQueries()).toBeUndefined();
    });

    test("STARTING + blocking — waits for RUNNING, then describes normally", async () => {
      vi.useFakeTimers();
      try {
        mocks.readdir.mockResolvedValue(["a.sql"]);
        mocks.readFile.mockResolvedValue("SELECT id FROM a");
        // Preflight sees STARTING (→ waitThenProceed); waitUntilRunning polls
        // STARTING once more, then RUNNING. After that, DESCRIBE runs.
        mocks.getWarehouse
          .mockReturnValueOnce({ state: "STARTING" })
          .mockReturnValueOnce({ state: "STARTING" })
          .mockReturnValue({ state: "RUNNING" });
        mocks.executeStatement.mockResolvedValue(
          succeededResult([["id", "INT", null]]),
        );

        const promise = generateQueriesFromDescribe("/queries", "wh-123", {
          mode: "blocking",
        });
        // Drive the wait loop's backoff sleep(s) so it can re-poll and observe
        // RUNNING. Run pending timers until the work settles.
        await vi.runAllTimersAsync();
        const { schemas, syntaxErrors, fatalErrors } = await promise;

        expect(mocks.executeStatement).toHaveBeenCalledTimes(1);
        expect(schemas).toHaveLength(1);
        expect(schemas[0].type).toContain("id: number");
        expect(syntaxErrors).toEqual([]);
        expect(fatalErrors).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    test("preflight connectivity error — degradeAll, never describes, flagged environmental for the gate", async () => {
      mocks.readdir.mockResolvedValue(["a.sql"]);
      mocks.readFile.mockResolvedValue("SELECT id FROM a");
      mocks.getWarehouse.mockImplementation(() => {
        throw Object.assign(
          new Error("Can't connect to https://x.cloud.databricks.com"),
          { code: 500 },
        );
      });

      const {
        schemas,
        syntaxErrors,
        fatalErrors,
        hadEnvironmentalFailure,
        environmentalCause,
      } = await generateQueriesFromDescribe("/queries", "wh-123", {
        mode: "blocking",
      });

      // Without the environmental flag a fresh checkout would exit 0 having
      // written no types at all: degraded queries suppress the write, and
      // nothing else fails the run.
      expect(mocks.executeStatement).not.toHaveBeenCalled();
      expect(fatalErrors).toEqual([]);
      expect(syntaxErrors).toEqual([]);
      expect(schemas[0].type).toContain("result: unknown");
      expect(hadEnvironmentalFailure).toBe(true);
      expect(environmentalCause).toBe("unreachable");
    });

    test("preflight auth error — environmentalCause is auth, including on response.status", async () => {
      mocks.readdir.mockResolvedValue(["a.sql"]);
      mocks.readFile.mockResolvedValue("SELECT id FROM a");
      // Status carried on `response.status` rather than `status` — some HTTP
      // clients report it there, and it must still label as auth.
      mocks.getWarehouse.mockImplementation(() => {
        throw Object.assign(new Error("PERMISSION_DENIED"), {
          response: { status: 403 },
        });
      });

      const { fatalErrors, hadEnvironmentalFailure, environmentalCause } =
        await generateQueriesFromDescribe("/queries", "wh-123", {
          mode: "blocking",
        });

      expect(mocks.executeStatement).not.toHaveBeenCalled();
      expect(fatalErrors).toEqual([]);
      expect(hadEnvironmentalFailure).toBe(true);
      expect(environmentalCause).toBe("auth");
    });

    test("per-query DESCRIBE connectivity failure is flagged environmental for the gate", async () => {
      mocks.readdir.mockResolvedValue(["a.sql"]);
      mocks.readFile.mockResolvedValue("SELECT id FROM a");
      mocks.getWarehouse.mockReturnValue({ state: "RUNNING" });
      mocks.executeStatement.mockRejectedValue(
        Object.assign(new Error("connect ECONNREFUSED"), {
          code: "ECONNREFUSED",
        }),
      );

      const {
        schemas,
        syntaxErrors,
        fatalErrors,
        hadEnvironmentalFailure,
        environmentalCause,
      } = await generateQueriesFromDescribe("/queries", "wh-123", {
        mode: "blocking",
      });

      expect(fatalErrors).toEqual([]);
      expect(syntaxErrors).toEqual([]);
      expect(schemas[0].type).toContain("result: unknown");
      expect(hadEnvironmentalFailure).toBe(true);
      expect(environmentalCause).toBe("unreachable");
    });

    test("non-blocking mode never reports an environmental cause", async () => {
      mocks.readdir.mockResolvedValue(["a.sql"]);
      mocks.readFile.mockResolvedValue("SELECT id FROM a");

      const { hadEnvironmentalFailure, environmentalCause } =
        await generateQueriesFromDescribe("/queries", "wh-123", {
          mode: "non-blocking",
        });

      // The gate is blocking-only; non-blocking degrades without signaling.
      expect(hadEnvironmentalFailure).toBe(false);
      expect(environmentalCause).toBeUndefined();
    });

    test("RUNNING preflight — describes normally", async () => {
      mocks.readdir.mockResolvedValue(["a.sql"]);
      mocks.readFile.mockResolvedValue("SELECT id FROM a");
      mocks.getWarehouse.mockReturnValue({ state: "RUNNING" });
      mocks.executeStatement.mockResolvedValue(
        succeededResult([["id", "INT", null]]),
      );

      const { schemas, fatalErrors } = await generateQueriesFromDescribe(
        "/queries",
        "wh-123",
        { mode: "blocking" },
      );

      expect(mocks.executeStatement).toHaveBeenCalledTimes(1);
      expect(schemas[0].type).toContain("id: number");
      expect(fatalErrors).toEqual([]);
    });

    test("non-blocking mode — skips probe + describe even when warehouse is RUNNING", async () => {
      mocks.readdir.mockResolvedValue(["a.sql", "b.sql"]);
      mocks.readFile
        .mockResolvedValueOnce("SELECT id FROM a")
        .mockResolvedValueOnce("SELECT id FROM b");
      // A RUNNING warehouse would normally take the proceed path and describe
      // every query. In `non-blocking` mode the warehouse is never even probed.
      mocks.getWarehouse.mockReturnValue({ state: "RUNNING" });

      const { schemas, syntaxErrors, fatalErrors } =
        await generateQueriesFromDescribe("/queries", "wh-123", {
          mode: "non-blocking",
        });

      // ZERO warehouse round-trips: no probe (getWarehouse) and no DESCRIBE.
      expect(mocks.getWarehouse).not.toHaveBeenCalled();
      expect(mocks.executeStatement).not.toHaveBeenCalled();
      // Best-available types: no cache seeded → every query degrades to unknown.
      expect(schemas).toHaveLength(2);
      expect(schemas[0].name).toBe("a");
      expect(schemas[0].type).toContain("result: unknown");
      expect(schemas[1].name).toBe("b");
      expect(schemas[1].type).toContain("result: unknown");
      // Degraded, never a failure.
      expect(syntaxErrors).toEqual([]);
      expect(fatalErrors).toEqual([]);
    });

    test("non-blocking mode — reuses the cached type when the SQL hash matches", async () => {
      const sql = "SELECT id FROM users";
      mocks.readdir.mockResolvedValue(["users.sql"]);
      mocks.readFile.mockResolvedValue(sql);
      // Seed a last-good cached type under the current SQL hash. non-blocking
      // serves it via the normal cache HIT path — still no probe, no DESCRIBE.
      mocks.loadCache.mockReturnValueOnce({
        version: CACHE_VERSION,
        queries: {
          users: { hash: hashSQL(sql), type: CACHED_GOOD_TYPE, retry: false },
        },
      });
      mocks.getWarehouse.mockReturnValue({ state: "RUNNING" });

      const { schemas, syntaxErrors, fatalErrors } =
        await generateQueriesFromDescribe("/queries", "wh-123", {
          mode: "non-blocking",
        });

      expect(mocks.getWarehouse).not.toHaveBeenCalled();
      expect(mocks.executeStatement).not.toHaveBeenCalled();
      expect(schemas).toHaveLength(1);
      expect(schemas[0].type).toBe(CACHED_GOOD_TYPE);
      expect(syntaxErrors).toEqual([]);
      expect(fatalErrors).toEqual([]);
    });
  });
});
