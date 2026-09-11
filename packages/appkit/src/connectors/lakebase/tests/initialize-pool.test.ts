import type { LakebasePoolConfig } from "@databricks/lakebase";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { runInUserContext } from "../../../context/execution-context";
import { ServiceContext } from "../../../context/service-context";
import type { UserContext } from "../../../context/user-context";

const mocks = vi.hoisted(() => {
  const me = vi.fn();
  const client = { currentUser: { me } };
  return {
    me,
    client,
    createPool: vi.fn(),
    createWorkspaceClient: vi.fn(() => ({
      toLegacyWorkspaceClient: () => client,
    })),
  };
});

// Keep identity resolution real; replace only the low-level pool allocation.
vi.mock("@databricks/lakebase", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@databricks/lakebase")>()),
  createLakebasePool: mocks.createPool,
}));
vi.mock("../../../workspace-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../workspace-client")>()),
  createWorkspaceClient: mocks.createWorkspaceClient,
}));

import { createLakebasePool, initializeLakebasePool } from "../index";

const pool = { query: vi.fn(), end: vi.fn() } as unknown as Pool;
type Client = NonNullable<LakebasePoolConfig["workspaceClient"]>;
function poolConfig(): Partial<LakebasePoolConfig> {
  return mocks.createPool.mock.lastCall?.[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("PGUSER", "");
  vi.stubEnv("DATABRICKS_CLIENT_ID", "");
  vi.spyOn(ServiceContext, "isInitialized").mockReturnValue(false);
  mocks.me.mockResolvedValue({ userName: "local-user@example.test" });
  mocks.createPool.mockReturnValue(pool);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("AppKit Lakebase connector initialization", () => {
  test("resolves a local username and returns the standalone connector's pool", async () => {
    expect(await initializeLakebasePool()).toBe(pool);
    expect(mocks.me).toHaveBeenCalledOnce();
    expect(mocks.createWorkspaceClient).toHaveBeenCalledWith({
      clientOptions: expect.objectContaining({ product: "@databricks/appkit" }),
    });
    expect(mocks.createPool).toHaveBeenCalledWith({
      user: "local-user@example.test",
      workspaceClient: mocks.client,
      logger: expect.any(Object),
    });
  });

  test.each([
    ["PGUSER", "postgres-role"],
    ["DATABRICKS_CLIENT_ID", "service-principal"],
  ])("uses %s without an identity API call", async (key, user) => {
    vi.stubEnv(key, user);
    await initializeLakebasePool();
    expect(poolConfig().user).toBe(user);
    expect(mocks.me).not.toHaveBeenCalled();
  });

  test("an explicit user wins over environment values", async () => {
    vi.stubEnv("PGUSER", "environment-user");
    vi.stubEnv("DATABRICKS_CLIENT_ID", "environment-client");
    await initializeLakebasePool({ user: "explicit-user" });
    expect(poolConfig().user).toBe("explicit-user");
    expect(mocks.me).not.toHaveBeenCalled();
  });

  test("uses the app service client for both lookup and pool authentication", async () => {
    const legacy = {
      currentUser: { me: vi.fn(async () => ({ userName: "app-user" })) },
    };
    vi.mocked(ServiceContext.isInitialized).mockReturnValue(true);
    vi.spyOn(ServiceContext, "get").mockReturnValue({
      client: { toLegacyWorkspaceClient: () => legacy },
    } as unknown as ReturnType<typeof ServiceContext.get>);
    await initializeLakebasePool();
    expect(poolConfig()).toMatchObject({
      user: "app-user",
      workspaceClient: legacy,
    });
    expect(mocks.createWorkspaceClient).not.toHaveBeenCalled();
    expect(legacy.currentUser.me).toHaveBeenCalledOnce();
  });

  test("an explicit workspace client wins over the app service client", async () => {
    const explicit = {
      currentUser: {
        me: vi.fn(async () => ({ userName: "explicit-client-user" })),
      },
    };
    vi.mocked(ServiceContext.isInitialized).mockReturnValue(true);
    const getContext = vi.spyOn(ServiceContext, "get");
    await initializeLakebasePool({
      workspaceClient: explicit as unknown as Client,
    });
    expect(poolConfig()).toMatchObject({
      user: "explicit-client-user",
      workspaceClient: explicit,
    });
    expect(getContext).not.toHaveBeenCalled();
    expect(mocks.createWorkspaceClient).not.toHaveBeenCalled();
  });

  test("PGUSER wins over the service principal environment value", async () => {
    vi.stubEnv("PGUSER", "postgres-role");
    vi.stubEnv("DATABRICKS_CLIENT_ID", "service-principal");
    await initializeLakebasePool();
    expect(poolConfig().user).toBe("postgres-role");
    expect(mocks.me).not.toHaveBeenCalled();
  });

  test("never selects an active request identity implicitly", async () => {
    const requestLookup = vi.fn(async () => ({ userName: "request-user" }));
    const requestClient = { currentUser: { me: requestLookup } };
    await runInUserContext(
      {
        client: { toLegacyWorkspaceClient: () => requestClient },
        userId: "request-user-id",
        userEmail: "request-user@example.test",
        workspaceId: Promise.resolve("workspace"),
        isUserContext: true,
      } as unknown as UserContext,
      () => initializeLakebasePool(),
    );
    expect(poolConfig().user).toBe("local-user@example.test");
    expect(poolConfig().workspaceClient).toBe(mocks.client);
    expect(requestLookup).not.toHaveBeenCalled();
  });

  test("does not substitute another identity when an explicit client fails", async () => {
    const explicit = {
      currentUser: {
        me: vi.fn(async () => {
          throw new Error("Lookup unavailable");
        }),
      },
    };
    await expect(
      initializeLakebasePool({
        workspaceClient: explicit as unknown as Client,
      }),
    ).rejects.toThrow("Could not determine the PostgreSQL user");
    expect(mocks.createWorkspaceClient).not.toHaveBeenCalled();
    expect(mocks.me).not.toHaveBeenCalled();
    expect(mocks.createPool).not.toHaveBeenCalled();
  });

  test("rejects an identity response without a username before allocation", async () => {
    mocks.me.mockResolvedValueOnce({ id: "identity-without-username" });
    await expect(initializeLakebasePool()).rejects.toThrow(
      "Could not determine the PostgreSQL user",
    );
    expect(mocks.createPool).not.toHaveBeenCalled();
  });

  test("passes pool options through without mutating caller configuration", async () => {
    const config = Object.freeze({
      user: "user",
      statement_timeout: 30_000,
      idle_in_transaction_session_timeout: 15_000,
      max: 4,
    });
    await initializeLakebasePool(config);
    expect(poolConfig()).toMatchObject(config);
    expect(poolConfig()).not.toBe(config);
    expect(config).not.toHaveProperty("workspaceClient");
  });

  test("preserves password authentication without requiring Databricks credentials", async () => {
    await initializeLakebasePool({
      user: "native-user",
      password: "test-only-password",
      host: "localhost",
      database: "test",
      sslMode: "disable",
    });
    expect(poolConfig().user).toBe("native-user");
    expect(poolConfig().password).toBe("test-only-password");
    expect(poolConfig().workspaceClient).toBeUndefined();
    expect(mocks.createWorkspaceClient).not.toHaveBeenCalled();
    expect(mocks.me).not.toHaveBeenCalled();
  });

  test("does not allocate a pool when identity cannot be resolved", async () => {
    mocks.me.mockRejectedValueOnce(new Error("Private auth detail"));
    await expect(initializeLakebasePool()).rejects.toMatchObject({
      code: "CONFIGURATION_ERROR",
      message: expect.stringContaining(
        "Could not determine the PostgreSQL user",
      ),
    });
    expect(mocks.createPool).not.toHaveBeenCalled();
  });

  test("keeps the existing pool factory synchronous", () => {
    const result = createLakebasePool({
      user: "explicit-user",
      password: "test-only",
    });
    expect(result).toBe(pool);
    expect(result).not.toBeInstanceOf(Promise);
    expect(mocks.me).not.toHaveBeenCalled();
    expect(mocks.createWorkspaceClient).not.toHaveBeenCalled();
  });
});
