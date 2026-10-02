import {
  type ExecutionContext,
  type UserContext,
  getCurrentUserId,
  getExecutionContext,
  getUserContext,
  getWarehouseId,
  isUserContext,
  runInUserContext,
  ServiceContext,
} from "@databricks/appkit";
import { afterEach, expect, test, vi } from "vitest";

import { mockServiceContext } from "../../testing/fixtures";

afterEach(() => vi.restoreAllMocks());

test("legacy public types and helpers retain identity and warehouse access", async () => {
  const mock = mockServiceContext();
  const warehouseId = Promise.resolve("legacy-warehouse");
  const legacy: UserContext = {
    client: mock.serviceContext.client,
    userId: "legacy-user",
    isUserContext: true,
    warehouseId,
    workspaceId: mock.serviceContext.workspaceId,
  };
  const execution: ExecutionContext = legacy;
  expect(isUserContext(execution)).toBe(true);
  await runInUserContext(legacy, async () => {
    const active = getExecutionContext();
    expect(isUserContext(active)).toBe(true);
    if (isUserContext(active)) {
      const userId: string = active.userId;
      expect(userId).toBe("legacy-user");
      expect(active.isUserContext).toBe(true);
    }
    const resource: Promise<string> | undefined = active.warehouseId;
    expect(resource).toBe(warehouseId);
    expect(getUserContext()?.warehouseId).toBe(warehouseId);
    expect(getWarehouseId()).toBe(warehouseId);
    expect(getCurrentUserId()).toBe("legacy-user");
  });
  expect(getCurrentUserId()).toBe(mock.serviceContext.serviceUserId);
});

test("the deprecated user factory remains callable through ServiceContext", () => {
  const mock = mockServiceContext();
  const legacy: UserContext = ServiceContext.createUserContext(
    "test-token",
    "alice",
  );
  expect(legacy.userId).toBe("alice");
  expect(legacy.isUserContext).toBe(true);
  expect(legacy.warehouseId).toBe(mock.serviceContext.warehouseId);
});
