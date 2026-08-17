import { afterEach, describe, expect, it, vi } from "vitest";

import { runExistenceProbe, toThreeLevelVolumeName } from "./checks-existence";
import type { ResourceTarget } from "./types";

// Mock the SDK bridge so the postgres probe runs without a real connection.
const { mockGetLakebasePool, endSpy } = vi.hoisted(() => ({
  mockGetLakebasePool: vi.fn(),
  endSpy: vi.fn(async () => {}),
}));
vi.mock("./databricks-client", () => ({
  AppkitNotInstalledError: class AppkitNotInstalledError extends Error {},
  getLakebasePool: mockGetLakebasePool,
}));

function target(overrides: Partial<ResourceTarget> = {}): ResourceTarget {
  return {
    type: "sql_warehouse",
    resourceKey: "sql-warehouse",
    alias: "SQL Warehouse",
    plugin: "analytics",
    requiredPermission: "CAN_USE",
    required: true,
    envVars: ["DATABRICKS_WAREHOUSE_ID"],
    fieldValues: { id: "wh-123" },
    ...overrides,
  };
}

/** Builds an SDK-like error carrying a statusCode (as ApiError does). */
function apiError(statusCode: number, message = "boom"): Error {
  return Object.assign(new Error(message), { statusCode });
}

describe("runExistenceProbe — sql_warehouse", () => {
  it("ok when the warehouse exists and is RUNNING", async () => {
    const client = {
      warehouses: { get: async () => ({ state: "RUNNING" }) },
    };
    const r = await runExistenceProbe(client, target());
    expect(r.status).toBe("ok");
  });

  it("warns when the warehouse exists but is STOPPED", async () => {
    const client = {
      warehouses: { get: async () => ({ state: "STOPPED" }) },
    };
    const r = await runExistenceProbe(client, target());
    expect(r.status).toBe("warn");
    expect(r.code).toBe("WAREHOUSE_NOT_RUNNING");
  });

  it("errors NOT_FOUND on a 404", async () => {
    const client = {
      warehouses: {
        get: async () => {
          throw apiError(404);
        },
      },
    };
    const r = await runExistenceProbe(client, target());
    expect(r.status).toBe("error");
    expect(r.code).toBe("NOT_FOUND");
  });

  it("errors INVALID_VALUE on a 400, quoting the value (no type/blob leak)", async () => {
    const client = {
      warehouses: {
        get: async () => {
          throw Object.assign(
            new Error(
              'Response from server (Bad Request) {"error_code":"INVALID_PARAMETER_VALUE","message":"bogus is not a valid endpoint id."}',
            ),
            { statusCode: 400, errorCode: "INVALID_PARAMETER_VALUE" },
          );
        },
      },
    };
    const r = await runExistenceProbe(
      client,
      target({ fieldValues: { id: "wh-123" } }),
    );
    expect(r.status).toBe("error");
    expect(r.code).toBe("INVALID_VALUE");
    expect(r.detail).toContain('"wh-123"');
    expect(r.detail).not.toContain("error_code");
    expect(r.detail).not.toContain("sql_warehouse");
  });

  it("errors ACCESS_DENIED on a 403", async () => {
    const client = {
      warehouses: {
        get: async () => {
          throw apiError(403);
        },
      },
    };
    const r = await runExistenceProbe(client, target());
    expect(r.status).toBe("error");
    expect(r.code).toBe("ACCESS_DENIED");
  });

  it("hedges on a 403, which several APIs also return for a missing resource", async () => {
    const client = {
      warehouses: {
        get: async () => {
          throw apiError(403);
        },
      },
    };
    const r = await runExistenceProbe(client, target());
    // Asserting "no permission" outright would misdiagnose a simple typo'd id.
    expect(r.detail).toMatch(/not found, or you don't have access to it/i);
    expect(r.detail).toContain("wh-1");
  });

  it("skips when the id field is missing", async () => {
    const client = { warehouses: { get: async () => ({}) } };
    const r = await runExistenceProbe(client, target({ fieldValues: {} }));
    expect(r.status).toBe("skipped");
    expect(r.code).toBe("MISSING_FIELD");
  });
});

describe("runExistenceProbe — job", () => {
  it("errors on a non-integer job id", async () => {
    const client = { jobs: { get: async () => ({}) } };
    const r = await runExistenceProbe(
      client,
      target({ type: "job", fieldValues: { id: "not-a-number" } }),
    );
    expect(r.status).toBe("error");
    expect(r.code).toBe("INVALID_ID");
  });

  it("ok for a valid integer job id", async () => {
    const client = { jobs: { get: async () => ({}) } };
    const r = await runExistenceProbe(
      client,
      target({ type: "job", fieldValues: { id: "42" } }),
    );
    expect(r.status).toBe("ok");
  });

  it("probes an int64 job id without losing precision", async () => {
    // Number() rounds past 2^53 while Number.isInteger still passes, so the old
    // guard would silently probe a *different* job and report a false not-found.
    const big = "9007199254740993"; // 2^53 + 1
    let seen: unknown;
    const client = {
      jobs: {
        get: async (req: { job_id: unknown }) => {
          seen = req.job_id;
          return {};
        },
      },
    };
    const r = await runExistenceProbe(
      client,
      target({ type: "job", fieldValues: { id: big } }),
    );
    expect(r.status).toBe("ok");
    expect(String(seen)).toBe(big);
  });

  it("rejects numeric forms the API can't take (1e3, 0x10)", async () => {
    const client = { jobs: { get: async () => ({}) } };
    for (const id of ["1e3", "0x10", "4.5", "-1"]) {
      const r = await runExistenceProbe(
        client,
        target({ type: "job", fieldValues: { id } }),
      );
      expect(r.code, `id=${id}`).toBe("INVALID_ID");
    }
  });
});

describe("runExistenceProbe — unsupported type", () => {
  it("skips NOT_IMPLEMENTED for a type with no probe", async () => {
    const r = await runExistenceProbe(
      {},
      target({ type: "secret", fieldValues: {} }),
    );
    expect(r.status).toBe("skipped");
    expect(r.code).toBe("NOT_IMPLEMENTED");
  });
});

describe("runExistenceProbe — postgres (Lakebase)", () => {
  afterEach(() => {
    mockGetLakebasePool.mockReset();
    endSpy.mockClear();
  });

  function pgTarget(overrides: Partial<ResourceTarget> = {}): ResourceTarget {
    return target({
      type: "postgres",
      requiredPermission: "CAN_CONNECT_AND_CREATE",
      fieldValues: { host: "ep.example.com", endpointPath: "projects/x" },
      ...overrides,
    });
  }

  it("ok when SELECT 1 succeeds, and closes the pool", async () => {
    const query = vi.fn(async () => ({ rows: [{ "?column?": 1 }] }));
    mockGetLakebasePool.mockResolvedValue({ query, end: endSpy });

    const r = await runExistenceProbe({}, pgTarget());
    expect(r.status).toBe("ok");
    expect(query).toHaveBeenCalledWith("SELECT 1");
    expect(endSpy).toHaveBeenCalled(); // pool always closed
  });

  it("errors CONNECTION_FAILED when the query throws, and still closes", async () => {
    const query = vi.fn(async () => {
      throw new Error("ECONNREFUSED 10.0.0.1:5432");
    });
    mockGetLakebasePool.mockResolvedValue({ query, end: endSpy });

    const r = await runExistenceProbe({}, pgTarget());
    expect(r.status).toBe("error");
    expect(r.code).toBe("CONNECTION_FAILED");
    expect(r.detail).toContain("ECONNREFUSED");
    expect(endSpy).toHaveBeenCalled();
  });

  it("adds an OAuth/PGUSER hint on 'password authentication failed'", async () => {
    const query = vi.fn(async () => {
      throw new Error(
        'password authentication failed for user "galymzhan.zhangazy%40databricks.com"',
      );
    });
    mockGetLakebasePool.mockResolvedValue({ query, end: endSpy });

    const r = await runExistenceProbe({}, pgTarget());
    expect(r.status).toBe("error");
    expect(r.code).toBe("CONNECTION_FAILED");
    expect(r.detail).toMatch(/password authentication failed/i);
    expect(r.hint).toMatch(/OAuth token as the password/i);
    expect(r.hint).toMatch(/PGUSER/);
  });

  it("does NOT add the auth hint for unrelated connection errors", async () => {
    const query = vi.fn(async () => {
      throw new Error("ECONNREFUSED 10.0.0.1:5432");
    });
    mockGetLakebasePool.mockResolvedValue({ query, end: endSpy });

    const r = await runExistenceProbe({}, pgTarget());
    expect(r.hint).toBeUndefined();
  });

  it("skips with MISSING_FIELD when neither host nor endpoint resolved", async () => {
    const r = await runExistenceProbe({}, pgTarget({ fieldValues: {} }));
    expect(r.status).toBe("skipped");
    expect(r.code).toBe("MISSING_FIELD");
    expect(mockGetLakebasePool).not.toHaveBeenCalled();
  });
});

describe("runExistenceProbe — per-type coverage with real manifest keys", () => {
  it("serving_endpoint: ok via `name`", async () => {
    const client = { servingEndpoints: { get: async () => ({}) } };
    const r = await runExistenceProbe(
      client,
      target({
        type: "serving_endpoint",
        fieldValues: { name: "my-endpoint" },
      }),
    );
    expect(r.status).toBe("ok");
  });

  it("serving_endpoint: hints id-vs-name when configured by id and the probe fails", async () => {
    const client = {
      servingEndpoints: {
        get: async () => {
          throw Object.assign(new Error("not found"), { statusCode: 404 });
        },
      },
    };
    const r = await runExistenceProbe(
      client,
      target({ type: "serving_endpoint", fieldValues: { id: "abc-123" } }),
    );
    expect(r.status).toBe("error");
    expect(r.hint).toMatch(/looked up by name/i);
  });

  it("serving_endpoint: no id-vs-name hint when configured by name", async () => {
    const client = {
      servingEndpoints: {
        get: async () => {
          throw Object.assign(new Error("not found"), { statusCode: 404 });
        },
      },
    };
    const r = await runExistenceProbe(
      client,
      target({ type: "serving_endpoint", fieldValues: { name: "my-ep" } }),
    );
    expect(r.status).toBe("error");
    expect(r.hint).toBeUndefined();
  });

  it("genie_space: ok via `id`", async () => {
    const client = { genie: { getSpace: async () => ({}) } };
    const r = await runExistenceProbe(
      client,
      target({ type: "genie_space", fieldValues: { id: "01ef" } }),
    );
    expect(r.status).toBe("ok");
  });

  it("volume: ok via `path` (real manifest key)", async () => {
    const client = { volumes: { read: async () => ({}) } };
    const r = await runExistenceProbe(
      client,
      target({
        type: "volume",
        fieldValues: { path: "/Volumes/main/default/files" },
      }),
    );
    expect(r.status).toBe("ok");
  });

  it("uc_function: ok via `name`", async () => {
    const client = { functions: { get: async () => ({}) } };
    const r = await runExistenceProbe(
      client,
      target({ type: "uc_function", fieldValues: { name: "cat.sch.fn" } }),
    );
    expect(r.status).toBe("ok");
  });

  it("vector_search_index: probes via camelCase `indexName`", async () => {
    const getIndex = vi.fn(async () => ({}));
    const client = { vectorSearchIndexes: { getIndex } };
    const r = await runExistenceProbe(
      client,
      target({
        type: "vector_search_index",
        fieldValues: { indexName: "main.default.idx", endpointName: "ep" },
      }),
    );
    expect(r.status).toBe("ok");
    expect(getIndex).toHaveBeenCalledWith({ index_name: "main.default.idx" });
  });

  it("vector_search_index: skips MISSING_FIELD when index name absent", async () => {
    const client = { vectorSearchIndexes: { getIndex: async () => ({}) } };
    const r = await runExistenceProbe(
      client,
      target({ type: "vector_search_index", fieldValues: {} }),
    );
    expect(r.status).toBe("skipped");
    expect(r.code).toBe("MISSING_FIELD");
  });
});

describe("toThreeLevelVolumeName", () => {
  it("passes through a dotted 3-level name", () => {
    expect(toThreeLevelVolumeName("main.default.files")).toBe(
      "main.default.files",
    );
  });

  it("extracts from a /Volumes path", () => {
    expect(toThreeLevelVolumeName("/Volumes/main/default/files/sub/x")).toBe(
      "main.default.files",
    );
  });

  it("returns null for an unparseable value", () => {
    expect(toThreeLevelVolumeName("just-a-name")).toBeNull();
  });
});
