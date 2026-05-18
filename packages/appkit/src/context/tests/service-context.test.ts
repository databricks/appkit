import { setupDatabricksEnv } from "@tools/test-helpers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  AuthenticationError,
  ConfigurationError,
  InitializationError,
} from "../../errors";
import { ServiceContext } from "../service-context";

// ── Mock @databricks/sdk-experimental ──────────────────────────────

const { mockMe, mockApiRequest, MockWorkspaceClient, MockConfigError } =
  vi.hoisted(() => {
    const mockMe = vi.fn();
    const mockApiRequest = vi.fn();

    const MockWorkspaceClient = vi.fn().mockImplementation(() => ({
      currentUser: { me: mockMe },
      apiClient: { request: mockApiRequest },
    }));

    class MockConfigError extends Error {
      baseMessage: string;
      constructor(message: string) {
        super(message);
        this.baseMessage = message;
      }
    }

    return { mockMe, mockApiRequest, MockWorkspaceClient, MockConfigError };
  });

vi.mock("@databricks/sdk-experimental", () => ({
  WorkspaceClient: MockWorkspaceClient,
  ConfigError: MockConfigError,
}));

// ── Helpers ────────────────────────────────────────────────────────

function setupDefaultMocks() {
  mockMe.mockResolvedValue({ id: "service-user-123" });
  mockApiRequest.mockResolvedValue({ "x-databricks-org-id": "ws-456" });
}

// ── Tests ──────────────────────────────────────────────────────────

describe("ServiceContext", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    ServiceContext.reset();
    setupDatabricksEnv();
    setupDefaultMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    ServiceContext.reset();
  });

  // ── initialize() ───────────────────────────────────────────────

  describe("initialize()", () => {
    test("should initialize with a pre-configured client", async () => {
      const client = new MockWorkspaceClient() as any;

      const state = await ServiceContext.initialize({}, client);

      expect(state.client).toBe(client);
      expect(state.serviceUserId).toBe("service-user-123");
      expect(await state.workspaceId).toBe("ws-456");
    });

    test("should create a WorkspaceClient when none is provided", async () => {
      await ServiceContext.initialize();

      // The mock constructor is called once internally
      expect(MockWorkspaceClient).toHaveBeenCalled();
    });

    test("should resolve warehouseId when options.warehouseId is true", async () => {
      process.env.DATABRICKS_WAREHOUSE_ID = "wh-789";

      const state = await ServiceContext.initialize({ warehouseId: true });

      expect(state.warehouseId).toBeDefined();
      expect(await state.warehouseId).toBe("wh-789");
    });

    test("should not set warehouseId when options.warehouseId is false", async () => {
      const state = await ServiceContext.initialize({ warehouseId: false });

      expect(state.warehouseId).toBeUndefined();
    });

    test("should not set warehouseId when options are omitted", async () => {
      const state = await ServiceContext.initialize();

      expect(state.warehouseId).toBeUndefined();
    });

    test("should throw when currentUser.me() returns no id", async () => {
      mockMe.mockResolvedValue({});

      await expect(ServiceContext.initialize()).rejects.toThrow(
        ConfigurationError,
      );
    });

    test("should be idempotent - calling twice returns same instance", async () => {
      const state1 = await ServiceContext.initialize();
      const state2 = await ServiceContext.initialize();

      expect(state1).toBe(state2);
    });

    test("concurrent calls return the same promise", async () => {
      const p1 = ServiceContext.initialize();
      const p2 = ServiceContext.initialize();

      const [state1, state2] = await Promise.all([p1, p2]);

      expect(state1).toBe(state2);
      // currentUser.me should only be called once regardless of concurrent calls
      expect(mockMe).toHaveBeenCalledTimes(1);
    });
  });

  // ── get() ──────────────────────────────────────────────────────

  describe("get()", () => {
    test("should throw InitializationError when not initialized", () => {
      expect(() => ServiceContext.get()).toThrow(InitializationError);
      expect(() => ServiceContext.get()).toThrow(
        /ServiceContext not initialized/,
      );
    });

    test("should return state after initialization", async () => {
      const state = await ServiceContext.initialize();
      const retrieved = ServiceContext.get();

      expect(retrieved).toBe(state);
    });
  });

  // ── isInitialized() ────────────────────────────────────────────

  describe("isInitialized()", () => {
    test("should return false before initialization", () => {
      expect(ServiceContext.isInitialized()).toBe(false);
    });

    test("should return true after initialization", async () => {
      await ServiceContext.initialize();

      expect(ServiceContext.isInitialized()).toBe(true);
    });

    test("should return false after reset()", async () => {
      await ServiceContext.initialize();
      ServiceContext.reset();

      expect(ServiceContext.isInitialized()).toBe(false);
    });
  });

  // ── createUserContext() ────────────────────────────────────────

  describe("createUserContext()", () => {
    beforeEach(async () => {
      await ServiceContext.initialize({ warehouseId: true });
    });

    test("should create a user context with correct properties", () => {
      const userCtx = ServiceContext.createUserContext(
        "user-token-abc",
        "user-42",
        "Alice",
      );

      expect(userCtx.userId).toBe("user-42");
      expect(userCtx.userName).toBe("Alice");
      expect(userCtx.isUserContext).toBe(true);
      expect(userCtx.client).toBeDefined();
    });

    test("should share warehouseId and workspaceId from service context", async () => {
      process.env.DATABRICKS_WAREHOUSE_ID = "wh-shared";

      // Re-initialize with the new env
      ServiceContext.reset();
      mockApiRequest.mockResolvedValue({ "x-databricks-org-id": "ws-shared" });
      await ServiceContext.initialize({ warehouseId: true });

      const userCtx = ServiceContext.createUserContext("user-token", "user-1");

      const serviceCtx = ServiceContext.get();
      expect(userCtx.warehouseId).toBe(serviceCtx.warehouseId);
      expect(userCtx.workspaceId).toBe(serviceCtx.workspaceId);
    });

    test("should create user client with PAT authType", () => {
      ServiceContext.createUserContext("user-token", "user-1");

      // The last call to MockWorkspaceClient should be for the user client
      const lastCall =
        MockWorkspaceClient.mock.calls[
          MockWorkspaceClient.mock.calls.length - 1
        ];
      expect(lastCall[0]).toMatchObject({
        token: "user-token",
        host: process.env.DATABRICKS_HOST,
        authType: "pat",
      });
    });

    test("should include tokenFingerprint derived from the token", () => {
      const userCtx = ServiceContext.createUserContext("user-token", "user-1");

      expect(userCtx.tokenFingerprint).toBeDefined();
      expect(typeof userCtx.tokenFingerprint).toBe("string");
      expect(userCtx.tokenFingerprint).toHaveLength(16);
    });

    test("should produce different fingerprints for different tokens", () => {
      const ctxA = ServiceContext.createUserContext("token-aaa", "user-1");
      const ctxB = ServiceContext.createUserContext("token-bbb", "user-1");

      expect(ctxA.tokenFingerprint).not.toBe(ctxB.tokenFingerprint);
    });

    test("should handle missing userName gracefully", () => {
      const userCtx = ServiceContext.createUserContext("user-token", "user-1");

      expect(userCtx.userName).toBeUndefined();
    });

    test("should throw AuthenticationError on missing token", () => {
      expect(() => ServiceContext.createUserContext("", "user-1")).toThrow(
        AuthenticationError,
      );
    });

    test("should throw ConfigurationError when DATABRICKS_HOST is not set", () => {
      delete process.env.DATABRICKS_HOST;

      expect(() => ServiceContext.createUserContext("token", "user-1")).toThrow(
        ConfigurationError,
      );
    });

    test("should throw InitializationError when service context is not initialized", () => {
      ServiceContext.reset();

      expect(() => ServiceContext.createUserContext("token", "user-1")).toThrow(
        InitializationError,
      );
    });
  });

  // ── reset() ────────────────────────────────────────────────────

  describe("reset()", () => {
    test("should clear the singleton state", async () => {
      await ServiceContext.initialize();
      expect(ServiceContext.isInitialized()).toBe(true);

      ServiceContext.reset();

      expect(ServiceContext.isInitialized()).toBe(false);
      expect(() => ServiceContext.get()).toThrow(InitializationError);
    });

    test("should allow re-initialization after reset", async () => {
      await ServiceContext.initialize();
      ServiceContext.reset();

      mockMe.mockResolvedValue({ id: "new-service-user" });
      const state = await ServiceContext.initialize();

      expect(state.serviceUserId).toBe("new-service-user");
    });
  });

  // ── getWorkspaceId() (private, tested via initialize) ─────────

  describe("getWorkspaceId()", () => {
    test("should use DATABRICKS_WORKSPACE_ID env var when set", async () => {
      process.env.DATABRICKS_WORKSPACE_ID = "env-ws-123";

      const state = await ServiceContext.initialize();

      expect(await state.workspaceId).toBe("env-ws-123");
      // Should not call the SCIM API when env var is set
      expect(mockApiRequest).not.toHaveBeenCalledWith(
        expect.objectContaining({ path: "/api/2.0/preview/scim/v2/Me" }),
      );
    });

    test("should call SCIM API when env var is not set", async () => {
      delete process.env.DATABRICKS_WORKSPACE_ID;
      mockApiRequest.mockResolvedValue({
        "x-databricks-org-id": "scim-ws-789",
      });

      const state = await ServiceContext.initialize();

      expect(await state.workspaceId).toBe("scim-ws-789");
      expect(mockApiRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          path: "/api/2.0/preview/scim/v2/Me",
          method: "GET",
          responseHeaders: ["x-databricks-org-id"],
        }),
      );
    });

    test("should throw when SCIM API returns no workspace ID", async () => {
      delete process.env.DATABRICKS_WORKSPACE_ID;
      mockApiRequest.mockResolvedValue({});

      await expect(ServiceContext.initialize()).rejects.toThrow(
        ConfigurationError,
      );
    });
  });

  // ── getWarehouseId() (private, tested via initialize) ─────────

  describe("getWarehouseId()", () => {
    test("should use DATABRICKS_WAREHOUSE_ID env var when set", async () => {
      process.env.DATABRICKS_WAREHOUSE_ID = "env-wh-abc";

      const state = await ServiceContext.initialize({ warehouseId: true });

      expect(await state.warehouseId).toBe("env-wh-abc");
    });

    test("should auto-discover warehouse in development mode", async () => {
      delete process.env.DATABRICKS_WAREHOUSE_ID;
      process.env.NODE_ENV = "development";

      mockApiRequest.mockImplementation(({ path }: { path: string }) => {
        if (path === "/api/2.0/sql/warehouses") {
          return Promise.resolve({
            warehouses: [
              { id: "wh-stopped", state: "STOPPED" },
              { id: "wh-running", state: "RUNNING" },
              { id: "wh-starting", state: "STARTING" },
            ],
          });
        }
        // SCIM response for workspaceId
        return Promise.resolve({ "x-databricks-org-id": "ws-dev" });
      });

      const state = await ServiceContext.initialize({ warehouseId: true });

      // Should pick RUNNING warehouse (highest priority)
      expect(await state.warehouseId).toBe("wh-running");
    });

    test("should sort warehouses by state priority in dev mode", async () => {
      delete process.env.DATABRICKS_WAREHOUSE_ID;
      process.env.NODE_ENV = "development";

      mockApiRequest.mockImplementation(({ path }: { path: string }) => {
        if (path === "/api/2.0/sql/warehouses") {
          return Promise.resolve({
            warehouses: [
              { id: "wh-stopping", state: "STOPPING" },
              { id: "wh-starting", state: "STARTING" },
              { id: "wh-stopped", state: "STOPPED" },
            ],
          });
        }
        return Promise.resolve({ "x-databricks-org-id": "ws-dev" });
      });

      const state = await ServiceContext.initialize({ warehouseId: true });

      // STOPPED (priority 1) < STARTING (priority 2) < STOPPING (priority 3)
      expect(await state.warehouseId).toBe("wh-stopped");
    });

    test("should throw in dev mode when no warehouses are available", async () => {
      delete process.env.DATABRICKS_WAREHOUSE_ID;
      process.env.NODE_ENV = "development";

      mockApiRequest.mockImplementation(({ path }: { path: string }) => {
        if (path === "/api/2.0/sql/warehouses") {
          return Promise.resolve({ warehouses: [] });
        }
        return Promise.resolve({ "x-databricks-org-id": "ws-dev" });
      });

      await expect(
        ServiceContext.initialize({ warehouseId: true }),
      ).rejects.toThrow(ConfigurationError);
    });

    test("should throw in dev mode when all warehouses are deleted", async () => {
      delete process.env.DATABRICKS_WAREHOUSE_ID;
      process.env.NODE_ENV = "development";

      mockApiRequest.mockImplementation(({ path }: { path: string }) => {
        if (path === "/api/2.0/sql/warehouses") {
          return Promise.resolve({
            warehouses: [
              { id: "wh-deleted", state: "DELETED" },
              { id: "wh-deleting", state: "DELETING" },
            ],
          });
        }
        return Promise.resolve({ "x-databricks-org-id": "ws-dev" });
      });

      await expect(
        ServiceContext.initialize({ warehouseId: true }),
      ).rejects.toThrow(ConfigurationError);
    });

    test("should throw in dev mode when best warehouse has no id", async () => {
      delete process.env.DATABRICKS_WAREHOUSE_ID;
      process.env.NODE_ENV = "development";

      mockApiRequest.mockImplementation(({ path }: { path: string }) => {
        if (path === "/api/2.0/sql/warehouses") {
          return Promise.resolve({
            warehouses: [{ state: "RUNNING" }],
          });
        }
        return Promise.resolve({ "x-databricks-org-id": "ws-dev" });
      });

      await expect(
        ServiceContext.initialize({ warehouseId: true }),
      ).rejects.toThrow(ConfigurationError);
    });

    test("should throw in production when DATABRICKS_WAREHOUSE_ID is not set", async () => {
      delete process.env.DATABRICKS_WAREHOUSE_ID;
      process.env.NODE_ENV = "production";

      await expect(
        ServiceContext.initialize({ warehouseId: true }),
      ).rejects.toThrow(ConfigurationError);
      await expect(
        ServiceContext.initialize({ warehouseId: true }),
      ).rejects.toThrow(/DATABRICKS_WAREHOUSE_ID/);
    });
  });

  // ── getClientOptions() ─────────────────────────────────────────

  describe("getClientOptions()", () => {
    test("should return product name and version", () => {
      const options = ServiceContext.getClientOptions();

      expect(options.product).toBe("@databricks/appkit");
      expect(options.productVersion).toBeDefined();
    });

    test("should include dev mode user agent extra in development", () => {
      process.env.NODE_ENV = "development";

      const options = ServiceContext.getClientOptions();

      expect(options.userAgentExtra).toEqual({ mode: "dev" });
    });

    test("should not include dev mode user agent extra in production", () => {
      process.env.NODE_ENV = "production";

      const options = ServiceContext.getClientOptions();

      expect(options.userAgentExtra).toBeUndefined();
    });
  });
});
