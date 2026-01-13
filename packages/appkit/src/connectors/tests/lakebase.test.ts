import { beforeEach, describe, expect, test, vi } from "vitest";
import { LakebaseConnector } from "../lakebase";

// Mock pg module
vi.mock("pg", () => {
  const mockQuery = vi.fn();
  const mockConnect = vi.fn();
  const mockEnd = vi.fn().mockResolvedValue(undefined);
  const mockRelease = vi.fn();
  const mockOn = vi.fn();

  const MockPool = vi.fn(() => ({
    query: mockQuery,
    connect: mockConnect,
    end: mockEnd,
    on: mockOn,
  }));

  return {
    default: { Pool: MockPool },
    Pool: MockPool,
    __mockQuery: mockQuery,
    __mockConnect: mockConnect,
    __mockEnd: mockEnd,
    __mockRelease: mockRelease,
    __mockOn: mockOn,
    __MockPool: MockPool,
  };
});

// Mock Databricks SDK
vi.mock("@databricks/sdk-experimental", () => {
  const mockMe = vi.fn();
  const mockRequest = vi.fn();

  const MockWorkspaceClient = vi.fn(() => ({
    currentUser: { me: mockMe },
    config: { host: "https://test.databricks.com" },
  }));

  const MockApiClient = vi.fn(() => ({
    request: mockRequest,
  }));

  const MockConfig = vi.fn(() => ({}));

  return {
    WorkspaceClient: MockWorkspaceClient,
    ApiClient: MockApiClient,
    Config: MockConfig,
    __mockMe: mockMe,
    __mockRequest: mockRequest,
    __MockWorkspaceClient: MockWorkspaceClient,
    __MockApiClient: MockApiClient,
  };
});

describe("LakebaseConnector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Set required env vars
    process.env.PGHOST = "test-host.databricks.com";
    process.env.PGDATABASE = "test-db";
    process.env.PGAPPNAME = "test-app";
  });

  describe("configuration", () => {
    test("should throw error when maxPoolSize is less than 1", () => {
      expect(
        () =>
          new LakebaseConnector({
            maxPoolSize: 0,
            workspaceClient: {} as any,
          }),
      ).toThrow("Invalid value for maxPoolSize");
    });

    test("should create connector with valid config", () => {
      const connector = new LakebaseConnector({
        workspaceClient: {} as any,
      });

      expect(connector).toBeInstanceOf(LakebaseConnector);
    });

    test("should throw when env vars are missing", () => {
      delete process.env.PGHOST;
      delete process.env.PGDATABASE;
      delete process.env.PGAPPNAME;

      expect(() => new LakebaseConnector()).toThrow(
        "Lakebase connection not configured",
      );
    });

    test("should throw when PGPORT is invalid", () => {
      process.env.PGPORT = "invalid";

      expect(() => new LakebaseConnector()).toThrow("Invalid value for port");
    });

    test("should parse env vars correctly", () => {
      process.env.PGPORT = "5433";
      process.env.PGSSLMODE = "disable";

      const connector = new LakebaseConnector();

      expect(connector).toBeInstanceOf(LakebaseConnector);
    });

    test("should use explicit config over env vars", () => {
      const connector = new LakebaseConnector({
        host: "explicit-host.databricks.com",
        database: "explicit-db",
        appName: "explicit-app",
        port: 5434,
        sslMode: "prefer",
        workspaceClient: {} as any,
      });

      expect(connector).toBeInstanceOf(LakebaseConnector);
    });
  });

  describe("query", () => {
    let connector: LakebaseConnector;
    let mockQuery: ReturnType<typeof vi.fn>;
    let mockMe: ReturnType<typeof vi.fn>;
    let mockRequest: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      const pg = await import("pg");
      const sdk = await import("@databricks/sdk-experimental");

      mockQuery = (pg as any).__mockQuery;
      mockMe = (sdk as any).__mockMe;
      mockRequest = (sdk as any).__mockRequest;

      // Setup default mocks
      mockMe.mockResolvedValue({ userName: "test-user@example.com" });
      mockRequest.mockResolvedValue({
        token: "test-oauth-token",
        expiration_time: new Date(Date.now() + 3600000).toISOString(), // 1 hour from now
      });
      mockQuery.mockResolvedValue({ rows: [{ result: 1 }] });

      connector = new LakebaseConnector({
        workspaceClient: {
          currentUser: { me: mockMe },
          config: { host: "https://test.databricks.com" },
        } as any,
      });
    });

    test("should execute query successfully", async () => {
      const result = await connector.query("SELECT 1 as result");

      expect(result.rows).toEqual([{ result: 1 }]);
      expect(mockQuery).toHaveBeenCalledWith("SELECT 1 as result", undefined);
    });

    test("should execute query with parameters", async () => {
      mockQuery.mockResolvedValue({ rows: [{ id: 1, name: "test" }] });

      const result = await connector.query(
        "SELECT * FROM users WHERE id = $1",
        [1],
      );

      expect(result.rows).toEqual([{ id: 1, name: "test" }]);
      expect(mockQuery).toHaveBeenCalledWith(
        "SELECT * FROM users WHERE id = $1",
        [1],
      );
    });

    test("should retry on auth error (28P01)", async () => {
      const authError = new Error("auth failed") as any;
      authError.code = "28P01";

      mockQuery
        .mockRejectedValueOnce(authError)
        .mockResolvedValue({ rows: [{ result: 1 }] });

      const result = await connector.query("SELECT 1");

      expect(result.rows).toEqual([{ result: 1 }]);
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    test("should retry once on transient error", async () => {
      const transientError = new Error("connection reset") as any;
      transientError.code = "ECONNRESET";

      mockQuery
        .mockRejectedValueOnce(transientError)
        .mockResolvedValue({ rows: [{ result: 1 }] });

      const result = await connector.query("SELECT 1");

      expect(result.rows).toEqual([{ result: 1 }]);
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    test("should not retry transient error more than once", async () => {
      const transientError = new Error("connection reset") as any;
      transientError.code = "ECONNRESET";

      mockQuery.mockRejectedValue(transientError);

      await expect(connector.query("SELECT 1")).rejects.toThrow("Query failed");
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    test("should throw non-retriable errors immediately", async () => {
      const syntaxError = new Error("syntax error") as any;
      syntaxError.code = "42601";

      mockQuery.mockRejectedValue(syntaxError);

      await expect(connector.query("SELEC 1")).rejects.toThrow("Query failed");
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });
  });

  describe("transaction", () => {
    let connector: LakebaseConnector;
    let mockConnect: ReturnType<typeof vi.fn>;
    let mockMe: ReturnType<typeof vi.fn>;
    let mockRequest: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      const pg = await import("pg");
      const sdk = await import("@databricks/sdk-experimental");

      mockConnect = (pg as any).__mockConnect;
      mockMe = (sdk as any).__mockMe;
      mockRequest = (sdk as any).__mockRequest;

      mockMe.mockResolvedValue({ userName: "test-user@example.com" });
      mockRequest.mockResolvedValue({
        token: "test-oauth-token",
        expiration_time: new Date(Date.now() + 3600000).toISOString(),
      });

      const mockClient = {
        query: vi.fn().mockResolvedValue({ rows: [] }),
        release: vi.fn(),
      };
      mockConnect.mockResolvedValue(mockClient);

      connector = new LakebaseConnector({
        workspaceClient: {
          currentUser: { me: mockMe },
          config: { host: "https://test.databricks.com" },
        } as any,
      });
    });

    test("should execute transaction successfully", async () => {
      const result = await connector.transaction(async (client) => {
        await client.query("BEGIN");
        await client.query("INSERT INTO test VALUES (1)");
        await client.query("COMMIT");
        return "success";
      });

      expect(result).toBe("success");
    });

    test("should release client after transaction", async () => {
      const mockClient = {
        query: vi.fn().mockResolvedValue({ rows: [] }),
        release: vi.fn(),
      };
      mockConnect.mockResolvedValue(mockClient);

      await connector.transaction(async (client) => {
        await client.query("SELECT 1");
        return "done";
      });

      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe("healthCheck", () => {
    let connector: LakebaseConnector;
    let mockQuery: ReturnType<typeof vi.fn>;
    let mockMe: ReturnType<typeof vi.fn>;
    let mockRequest: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      const pg = await import("pg");
      const sdk = await import("@databricks/sdk-experimental");

      mockQuery = (pg as any).__mockQuery;
      mockMe = (sdk as any).__mockMe;
      mockRequest = (sdk as any).__mockRequest;

      mockMe.mockResolvedValue({ userName: "test-user@example.com" });
      mockRequest.mockResolvedValue({
        token: "test-oauth-token",
        expiration_time: new Date(Date.now() + 3600000).toISOString(),
      });

      connector = new LakebaseConnector({
        workspaceClient: {
          currentUser: { me: mockMe },
          config: { host: "https://test.databricks.com" },
        } as any,
      });
    });

    test("should return true when database is healthy", async () => {
      mockQuery.mockResolvedValue({ rows: [{ result: 1 }] });

      const isHealthy = await connector.healthCheck();

      expect(isHealthy).toBe(true);
    });

    test("should return false when database is unhealthy", async () => {
      mockQuery.mockRejectedValue(new Error("connection failed"));

      const isHealthy = await connector.healthCheck();

      expect(isHealthy).toBe(false);
    });

    test("should return false when result is unexpected", async () => {
      mockQuery.mockResolvedValue({ rows: [{ result: 0 }] });

      const isHealthy = await connector.healthCheck();

      expect(isHealthy).toBe(false);
    });
  });

  describe("close", () => {
    let connector: LakebaseConnector;
    let mockEnd: ReturnType<typeof vi.fn>;
    let mockQuery: ReturnType<typeof vi.fn>;
    let mockMe: ReturnType<typeof vi.fn>;
    let mockRequest: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      const pg = await import("pg");
      const sdk = await import("@databricks/sdk-experimental");

      mockEnd = (pg as any).__mockEnd;
      mockQuery = (pg as any).__mockQuery;
      mockMe = (sdk as any).__mockMe;
      mockRequest = (sdk as any).__mockRequest;

      mockMe.mockResolvedValue({ userName: "test-user@example.com" });
      mockRequest.mockResolvedValue({
        token: "test-oauth-token",
        expiration_time: new Date(Date.now() + 3600000).toISOString(),
      });
      mockQuery.mockResolvedValue({ rows: [{ result: 1 }] });
      mockEnd.mockResolvedValue(undefined);

      connector = new LakebaseConnector({
        workspaceClient: {
          currentUser: { me: mockMe },
          config: { host: "https://test.databricks.com" },
        } as any,
      });
    });

    test("should close connection pool", async () => {
      // Initialize pool by making a query
      await connector.query("SELECT 1");

      await connector.close();

      expect(mockEnd).toHaveBeenCalled();
    });

    test("should handle close when pool not initialized", async () => {
      // Don't make any queries, pool is not initialized
      await expect(connector.close()).resolves.not.toThrow();
    });
  });

  describe("credentials", () => {
    let mockMe: ReturnType<typeof vi.fn>;
    let mockRequest: ReturnType<typeof vi.fn>;
    let mockQuery: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      const pg = await import("pg");
      const sdk = await import("@databricks/sdk-experimental");

      mockQuery = (pg as any).__mockQuery;
      mockMe = (sdk as any).__mockMe;
      mockRequest = (sdk as any).__mockRequest;

      mockQuery.mockResolvedValue({ rows: [{ result: 1 }] });
    });

    test("should throw when username cannot be fetched", async () => {
      mockMe.mockResolvedValue({ userName: null });
      mockRequest.mockResolvedValue({ token: "test-token" });

      const connector = new LakebaseConnector({
        workspaceClient: {
          currentUser: { me: mockMe },
          config: { host: "https://test.databricks.com" },
        } as any,
      });

      await expect(connector.query("SELECT 1")).rejects.toThrow(
        "Failed to get current user",
      );
    });

    test("should throw when token cannot be fetched", async () => {
      mockMe.mockResolvedValue({ userName: "test-user@example.com" });
      mockRequest.mockResolvedValue({ error: "unauthorized" }); // missing token and expiration_time

      const connector = new LakebaseConnector({
        workspaceClient: {
          currentUser: { me: mockMe },
          config: { host: "https://test.databricks.com" },
        } as any,
      });

      await expect(connector.query("SELECT 1")).rejects.toThrow(
        "Failed to generate credentials",
      );
    });
  });

  describe("transient error codes", () => {
    let connector: LakebaseConnector;
    let mockQuery: ReturnType<typeof vi.fn>;
    let mockMe: ReturnType<typeof vi.fn>;
    let mockRequest: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      const pg = await import("pg");
      const sdk = await import("@databricks/sdk-experimental");

      mockQuery = (pg as any).__mockQuery;
      mockMe = (sdk as any).__mockMe;
      mockRequest = (sdk as any).__mockRequest;

      mockMe.mockResolvedValue({ userName: "test-user@example.com" });
      mockRequest.mockResolvedValue({
        token: "test-oauth-token",
        expiration_time: new Date(Date.now() + 3600000).toISOString(),
      });

      connector = new LakebaseConnector({
        workspaceClient: {
          currentUser: { me: mockMe },
          config: { host: "https://test.databricks.com" },
        } as any,
      });
    });

    const transientCodes = [
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "57P01", // admin_shutdown
      "57P03", // cannot_connect_now
      "08006", // connection_failure
      "08003", // connection_does_not_exist
      "08000", // connection_exception
    ];

    test.each(transientCodes)(
      "should retry on transient error code: %s",
      async (code) => {
        const error = new Error(`transient error ${code}`) as any;
        error.code = code;

        mockQuery
          .mockRejectedValueOnce(error)
          .mockResolvedValue({ rows: [{ result: 1 }] });

        const result = await connector.query("SELECT 1");

        expect(result.rows).toEqual([{ result: 1 }]);
        expect(mockQuery).toHaveBeenCalledTimes(2);
      },
    );
  });
});
