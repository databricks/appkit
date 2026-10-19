import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { createWorkspaceClient, createLakebasePool } = vi.hoisted(() => ({
  createWorkspaceClient: vi.fn(),
  createLakebasePool: vi.fn(),
}));

vi.mock("../../../connectors/lakebase", () => ({ createLakebasePool }));
vi.mock("../../../workspace-client", () => ({ createWorkspaceClient }));

import { getClientOptions } from "../../../context/client-options";
import { createDbContext, withBranchPool } from "../context";
import type { LakebaseApi } from "../lakebase-api";
import { cleanupTempApps, FakeLakebase, fakeContext, tempApp } from "./fakes";

const BRANCH = "projects/p/branches/dev-alice-3f9a2c";
const ENDPOINT = `${BRANCH}/endpoints/primary`;
const HOST = "primary.dev-alice-3f9a2c.example.com";
const pool = { end: vi.fn(async () => undefined) };
const usePool = async (p: unknown) => p;

beforeEach(() => {
  createLakebasePool.mockReset().mockReturnValue(pool);
  pool.end.mockClear();
  createWorkspaceClient.mockReset();
});
afterEach(cleanupTempApps);

function contextFor(env: NodeJS.ProcessEnv, api: LakebaseApi) {
  return fakeContext({ root: tempApp(), env, api });
}

describe("withBranchPool", () => {
  test("refuses without PGHOST, PGDATABASE and LAKEBASE_ENDPOINT, before any API call", async () => {
    const lakebase = new FakeLakebase();

    await expect(
      withBranchPool(
        contextFor({ PGHOST: HOST, PGDATABASE: "db" }, lakebase.api()),
        usePool,
      ),
    ).rejects.toThrow(
      "Did not connect: no branch is configured in .env (PGHOST, PGDATABASE and LAKEBASE_ENDPOINT); run `appkit db init`.",
    );
    expect(lakebase.calls).toEqual([]);
    expect(createLakebasePool).not.toHaveBeenCalled();
  });

  test("connects to PGHOST once it is a host of LAKEBASE_ENDPOINT", async () => {
    const lakebase = new FakeLakebase();
    lakebase.addBranch(BRANCH);
    const ctx = contextFor(
      {
        PGHOST: HOST.toUpperCase(),
        PGDATABASE: "databricks_postgres",
        LAKEBASE_ENDPOINT: ENDPOINT,
        PGUSER: "alice@example.com",
      },
      lakebase.api(),
    );

    await expect(withBranchPool(ctx, usePool)).resolves.toBe(pool);
    expect(pool.end).toHaveBeenCalledOnce();
    expect(lakebase.calls).toEqual([`getEndpoint ${ENDPOINT}`]);
    expect(createLakebasePool).toHaveBeenCalledWith(
      expect.objectContaining({
        host: HOST.toUpperCase(),
        database: "databricks_postgres",
        endpoint: ENDPOINT,
        user: "alice@example.com",
        max: 2,
      }),
    );
  });

  test("without PGUSER the pool connects as the Databricks identity, and the endpoint is looked up once", async () => {
    const lakebase = new FakeLakebase();
    lakebase.addBranch(BRANCH);
    const ctx = fakeContext({
      root: tempApp(),
      env: {
        PGHOST: HOST,
        PGDATABASE: "databricks_postgres",
        LAKEBASE_ENDPOINT: ENDPOINT,
      },
      userName: "4b2c1e0a-9d8f-4e7a-b6c5-3d2e1f0a9b8c",
      api: lakebase.api(),
    });

    await withBranchPool(ctx, usePool);

    expect(lakebase.calls).toEqual([`getEndpoint ${ENDPOINT}`]);
    expect(createLakebasePool).toHaveBeenCalledWith(
      expect.objectContaining({ user: "4b2c1e0a-9d8f-4e7a-b6c5-3d2e1f0a9b8c" }),
    );
  });

  test("refuses another branch's host, a missing endpoint, or a failed lookup, and never connects", async () => {
    const lakebase = new FakeLakebase();
    lakebase.addBranch(BRANCH);
    const env = {
      PGDATABASE: "databricks_postgres",
      LAKEBASE_ENDPOINT: ENDPOINT,
    };

    await expect(
      withBranchPool(
        contextFor(
          { ...env, PGHOST: "primary.production.example.com" },
          lakebase.api(),
        ),
        usePool,
      ),
    ).rejects.toThrow(
      `PGHOST primary.production.example.com is not a host of LAKEBASE_ENDPOINT ${ENDPOINT} (expected ${HOST}), so it did not connect. Run \`appkit db init\` to rewrite .env.`,
    );
    await expect(
      withBranchPool(
        contextFor(
          {
            ...env,
            PGHOST: HOST,
            LAKEBASE_ENDPOINT: `${BRANCH}/endpoints/gone`,
          },
          lakebase.api(),
        ),
        usePool,
      ),
    ).rejects.toThrow(
      `LAKEBASE_ENDPOINT ${BRANCH}/endpoints/gone does not exist, so it did not connect.`,
    );

    const lookupFailure = new Error("Lakebase: get endpoint failed: timeout");
    const failing = {
      getEndpoint: async () => {
        throw lookupFailure;
      },
    } as unknown as LakebaseApi;
    const error = (await withBranchPool(
      contextFor({ ...env, PGHOST: HOST }, failing),
      usePool,
    ).catch((caught: unknown) => caught)) as Error;
    expect(error.message).toBe(
      `Could not verify that PGHOST ${HOST} serves LAKEBASE_ENDPOINT ${ENDPOINT}, so it did not connect.`,
    );
    expect(error.cause).toBe(lookupFailure);

    expect(createLakebasePool).not.toHaveBeenCalled();
  });

  test("closes the pool when fn fails, and rethrows fn's error", async () => {
    const lakebase = new FakeLakebase();
    lakebase.addBranch(BRANCH);
    const ctx = contextFor(
      {
        PGHOST: HOST,
        PGDATABASE: "databricks_postgres",
        LAKEBASE_ENDPOINT: ENDPOINT,
        PGUSER: "alice@example.com",
      },
      lakebase.api(),
    );
    const failure = new Error("query failed");
    pool.end.mockRejectedValueOnce(new Error("end failed"));

    await expect(
      withBranchPool(ctx, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(pool.end).toHaveBeenCalledOnce();
  });
});

describe("createDbContext", () => {
  test("the workspace client uses the .env profile and AppKit's client options, once", () => {
    const legacy = { apiClient: {}, currentUser: {} };
    createWorkspaceClient.mockReturnValue({
      toLegacyWorkspaceClient: () => legacy,
    });
    const ctx = createDbContext({
      root: tempApp(),
      env: { DATABRICKS_CONFIG_PROFILE: "dev" },
    });

    expect(ctx.workspace()).toBe(legacy);
    expect(ctx.workspace()).toBe(legacy);
    expect(createWorkspaceClient).toHaveBeenCalledOnce();
    expect(createWorkspaceClient).toHaveBeenCalledWith({
      profile: "dev",
      clientOptions: getClientOptions(),
    });
  });
});
