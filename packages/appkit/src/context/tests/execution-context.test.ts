import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { getWarehouseId } from "../../resources";
import { AppResources } from "../../resources/app-resources";
import { createMockWorkspaceClient } from "../../testing/mock-workspace-client";
import * as workspaceClient from "../../workspace-client";
import { getUserContext } from "../execution-context";
import {
  type CallerContext,
  type UserContext,
  getCallerContext,
  getCurrentActorId,
  getCurrentPrincipalKey,
  getCurrentUserId,
  getExecutionContext,
  getWarehouseId as getLegacyWarehouseId,
  getWorkspaceClient,
  isCallerContext,
  runInCallerContext,
  runInUserContext,
  ServiceContext,
} from "../index";
import { type ExecutionContext, isUserContext } from "../user-context";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../../logging/logger", () => ({
  createLogger: () => ({ warn }),
}));

const service = Object.freeze({
  client: createMockWorkspaceClient(),
  serviceUserId: "service-123",
  workspaceId: Promise.resolve("workspace-123"),
  warehouseId: Promise.resolve("warehouse-123"),
} satisfies ExecutionContext);

function caller(userId: string): CallerContext {
  return {
    client: createMockWorkspaceClient(),
    principal: { type: "user", userId },
    workspaceId: service.workspaceId,
  };
}

describe("caller execution context", () => {
  beforeEach(() => {
    vi.spyOn(ServiceContext, "get").mockReturnValue(service);
    vi.spyOn(AppResources, "get").mockReturnValue({
      warehouseId: service.warehouseId,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  test("defaults to the SP and has no initiating user", () => {
    expect(getExecutionContext()).toBe(service);
    expect(getWorkspaceClient()).toBe(service.client);
    expect(getCurrentPrincipalKey()).toBe("app");
    expect(getCurrentActorId()).toBeUndefined();
    expect(getCallerContext()).toBeUndefined();
    expect(isCallerContext(service)).toBe(false);
  });

  test("caller accessors work without an initialized service context", () => {
    vi.mocked(ServiceContext.get).mockImplementation(() => {
      throw new Error("not initialized");
    });
    expect(getCallerContext()).toBeUndefined();
    expect(getCurrentActorId()).toBeUndefined();
    runInCallerContext(caller("alice"), () => {
      expect(getCurrentPrincipalKey()).toBe("user:alice");
      expect(getCurrentActorId()).toBe("alice");
    });
  });

  test("isolates concurrent callers across asynchronous work", async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const alice = runInCallerContext(caller("alice"), async () => {
      await barrier;
      expect(getCurrentActorId()).toBe("alice");
      return getCurrentPrincipalKey();
    });
    const bob = runInCallerContext(caller("bob"), async () => {
      release();
      await Promise.resolve();
      expect(getCurrentActorId()).toBe("bob");
      return getCurrentPrincipalKey();
    });
    expect(await Promise.all([alice, bob])).toEqual(["user:alice", "user:bob"]);
    expect(getExecutionContext()).toBe(service);
  });

  test("restores the parent after a nested scope throws or rejects", async () => {
    await runInCallerContext(caller("alice"), async () => {
      expect(() =>
        runInCallerContext(caller("bob"), () => {
          throw new Error("sync failure");
        }),
      ).toThrow("sync failure");
      expect(getCurrentActorId()).toBe("alice");
      await expect(
        runInCallerContext(caller("bob"), async () => {
          await Promise.resolve();
          throw new Error("async failure");
        }),
      ).rejects.toThrow("async failure");
      expect(getCurrentActorId()).toBe("alice");
    });
    expect(getExecutionContext()).toBe(service);
  });

  test("snapshots the input and freezes context and principal, but not the client", () => {
    const input = {
      ...caller("alice"),
      principal: { type: "user" as const, userId: "alice" },
    };
    runInCallerContext(input, () => {
      input.principal.userId = "bob";
      const active = getCallerContext();
      if (!active) throw new Error("Expected an active caller");
      expect(getCurrentPrincipalKey()).toBe("user:alice");
      expect(Object.isFrozen(active)).toBe(true);
      expect(Object.isFrozen(active.principal)).toBe(true);
      expect(Reflect.set(active.principal, "userId", "charlie")).toBe(false);
      expect(Reflect.set(active, "principal", input.principal)).toBe(false);
      expect(active.client).toBe(input.client);
      expect(Object.isFrozen(active.client)).toBe(false);
    });
  });

  test("creates the same token client and immutable user principal", () => {
    vi.stubEnv("DATABRICKS_HOST", "https://workspace.example.com");
    const client = createMockWorkspaceClient();
    const createClient = vi
      .spyOn(workspaceClient, "createWorkspaceClient")
      .mockReturnValue(client);
    const context = ServiceContext.createCallerContext(
      "token",
      "alice",
      "Alice",
      "alice@example.com",
    );
    expect(context.principal).toEqual({
      type: "user",
      userId: "alice",
      userName: "Alice",
      userEmail: "alice@example.com",
    });
    expect(createClient).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "token",
        host: "https://workspace.example.com",
        authType: "pat",
      }),
    );
    expect(context.client).toBe(client);
    expect(context).not.toHaveProperty("warehouseId");
    expect(context.workspaceId).toBe(service.workspaceId);
    expect(context.tokenFingerprint).toHaveLength(16);
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.principal)).toBe(true);
  });

  test("legacy aliases preserve IDs and fields and warn once per name", () => {
    vi.stubEnv("DATABRICKS_HOST", "https://workspace.example.com");
    vi.spyOn(workspaceClient, "createWorkspaceClient").mockReturnValue(
      service.client,
    );
    warn.mockClear();
    for (let i = 0; i < 2; i++) {
      const context = ServiceContext.createUserContext(
        "token",
        "alice",
        "Alice",
        "alice@example.com",
      );
      expect(
        runInUserContext(context, () => {
          expect(getCurrentUserId()).toBe("alice");
          expect(getCurrentPrincipalKey()).toBe("user:alice");
          expect(isUserContext(getExecutionContext())).toBe(true);
          const legacy = getUserContext();
          if (!legacy) throw new Error("Expected an active legacy context");
          expect(legacy.userId).toBe("alice");
          expect(legacy.userName).toBe("Alice");
          expect(legacy.userEmail).toBe("alice@example.com");
          expect(legacy.isUserContext).toBe(true);
          expect(legacy.warehouseId).toBe(service.warehouseId);
          expect(getLegacyWarehouseId()).toBe(getWarehouseId());
          return 42;
        }),
      ).toBe(42);
      expect(getCurrentUserId()).toBe("service-123");
    }
    for (const name of [
      "ServiceContext.createUserContext",
      "runInUserContext",
      "getCurrentUserId",
      "getUserContext",
      "isUserContext",
      "UserContext.userId",
      "UserContext.userName",
      "UserContext.userEmail",
      "UserContext.isUserContext",
      "UserContext.warehouseId",
      "context.getWarehouseId",
    ]) {
      expect(
        warn.mock.calls.filter(([message]) =>
          message.startsWith(`${name} is deprecated.`),
        ),
      ).toHaveLength(1);
    }
  });

  test("accepts an existing legacy context without mutating it", () => {
    const legacy: UserContext = {
      client: service.client,
      workspaceId: service.workspaceId,
      userId: "alice",
      isUserContext: true,
    };
    runInUserContext(legacy, () => {
      expect(getCurrentActorId()).toBe("alice");
      expect(getCurrentPrincipalKey()).toBe("user:alice");
    });
    expect(legacy).not.toHaveProperty("principal");
    expect(Object.isFrozen(legacy)).toBe(false);
  });

  test("shares the app warehouse without changing the caller's client", async () => {
    expect(getWarehouseId()).toBe(service.warehouseId);
    const alice = caller("alice");
    await runInCallerContext(alice, async () => {
      await Promise.resolve();
      expect(getCallerContext()).not.toHaveProperty("warehouseId");
      expect(getExecutionContext()).not.toHaveProperty("warehouseId");
      expect(getWarehouseId()).toBe(service.warehouseId);
      expect(await getWarehouseId()).toBe("warehouse-123");
      expect(getWorkspaceClient()).toBe(alice.client);
    });
    expect(getWorkspaceClient()).toBe(service.client);
  });

  test("reports a missing app warehouse in both service and caller scopes", () => {
    vi.mocked(AppResources.get).mockReturnValue({});
    expect(getWarehouseId).toThrow("No plugin requires a SQL Warehouse");
    runInCallerContext(caller("alice"), () => {
      expect(getWarehouseId).toThrow("No plugin requires a SQL Warehouse");
    });
  });

  test("ignores resource fields on canonical caller inputs", () => {
    const input = {
      ...caller("alice"),
      warehouseId: Promise.resolve("not-the-app-warehouse"),
    };
    runInCallerContext(input, () => {
      expect(getCallerContext()).not.toHaveProperty("warehouseId");
      expect(getWarehouseId()).toBe(service.warehouseId);
    });
  });

  test("isolates and snapshots legacy warehouse overrides outside caller identity", async () => {
    const warehouseId = Promise.resolve("legacy-warehouse");
    const legacy: UserContext = {
      client: createMockWorkspaceClient(),
      workspaceId: service.workspaceId,
      userId: "alice",
      isUserContext: true,
      warehouseId,
    };
    await Promise.all([
      runInUserContext(legacy, async () => {
        legacy.warehouseId = Promise.resolve("changed");
        await Promise.resolve();
        expect(getWarehouseId()).toBe(warehouseId);
        expect(getUserContext()?.warehouseId).toBe(warehouseId);
        expect(getCallerContext()).not.toHaveProperty("warehouseId");
        expect(getWorkspaceClient()).toBe(legacy.client);
        await expect(
          runInCallerContext(caller("bob"), async () => {
            expect(getWarehouseId()).toBe(service.warehouseId);
            throw new Error("nested failure");
          }),
        ).rejects.toThrow("nested failure");
        expect(getWarehouseId()).toBe(warehouseId);
      }),
      runInCallerContext(caller("charlie"), async () => {
        await Promise.resolve();
        expect(getWarehouseId()).toBe(service.warehouseId);
      }),
    ]);
    expect(getWarehouseId()).toBe(service.warehouseId);
  });

  test("preserves a missing warehouse in legacy contexts", () => {
    runInUserContext(
      {
        client: service.client,
        workspaceId: service.workspaceId,
        userId: "alice",
        isUserContext: true,
      },
      () => {
        expect(getUserContext()?.warehouseId).toBeUndefined();
        expect(getWarehouseId).toThrow("No plugin requires a SQL Warehouse");
      },
    );
  });

  test("legacy entry points accept warehouse-free caller contexts", () => {
    runInUserContext(caller("alice"), () => {
      expect(getWarehouseId()).toBe(service.warehouseId);
      expect(getUserContext()?.warehouseId).toBe(service.warehouseId);
    });
  });
});
