import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { createWorkspaceClient, initializeLakebasePool } = vi.hoisted(() => ({
  createWorkspaceClient: vi.fn(),
  initializeLakebasePool: vi.fn(),
}));

vi.mock("../../../connectors/lakebase", () => ({ initializeLakebasePool }));
vi.mock("../../../workspace-client", () => ({ createWorkspaceClient }));

import { getClientOptions } from "../../../context/client-options";
import { createDbContext, openBranchPool } from "../context";
import type { LakebaseApi } from "../lakebase-api";
import { cleanupTempApps, FakeLakebase, fakeContext, tempApp } from "./fakes";

const BRANCH = "projects/p/branches/dev-alice-3f9a2c";
const ENDPOINT = `${BRANCH}/endpoints/primary`;
const HOST = "primary.dev-alice-3f9a2c.example.com";
const pool = { end: vi.fn() };

beforeEach(() => {
  initializeLakebasePool.mockReset().mockResolvedValue(pool);
  createWorkspaceClient.mockReset();
});
afterEach(cleanupTempApps);

function contextFor(env: NodeJS.ProcessEnv, api: LakebaseApi) {
  return fakeContext({ root: tempApp(), env, api });
}

describe("openBranchPool", () => {
  test("null without PGHOST, PGDATABASE and LAKEBASE_ENDPOINT, before any API call", async () => {
    const lakebase = new FakeLakebase();

    await expect(
      openBranchPool(
        contextFor({ PGHOST: HOST, PGDATABASE: "db" }, lakebase.api()),
      ),
    ).resolves.toBeNull();
    expect(lakebase.calls).toEqual([]);
    expect(initializeLakebasePool).not.toHaveBeenCalled();
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

    await expect(openBranchPool(ctx)).resolves.toBe(pool);
    expect(lakebase.calls).toEqual([`getEndpoint ${ENDPOINT}`]);
    expect(initializeLakebasePool).toHaveBeenCalledWith(
      expect.objectContaining({
        host: HOST.toUpperCase(),
        database: "databricks_postgres",
        endpoint: ENDPOINT,
        user: "alice@example.com",
        max: 2,
      }),
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
      openBranchPool(
        contextFor(
          { ...env, PGHOST: "primary.production.example.com" },
          lakebase.api(),
        ),
      ),
    ).rejects.toThrow(
      `PGHOST primary.production.example.com is not a host of LAKEBASE_ENDPOINT ${ENDPOINT} (expected ${HOST}), so it did not connect. Run \`appkit db init\` to rewrite .env.`,
    );
    await expect(
      openBranchPool(
        contextFor(
          {
            ...env,
            PGHOST: HOST,
            LAKEBASE_ENDPOINT: `${BRANCH}/endpoints/gone`,
          },
          lakebase.api(),
        ),
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
    const error = (await openBranchPool(
      contextFor({ ...env, PGHOST: HOST }, failing),
    ).catch((caught: unknown) => caught)) as Error;
    expect(error.message).toBe(
      `Could not verify that PGHOST ${HOST} serves LAKEBASE_ENDPOINT ${ENDPOINT}, so it did not connect.`,
    );
    expect(error.cause).toBe(lookupFailure);

    expect(initializeLakebasePool).not.toHaveBeenCalled();
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
