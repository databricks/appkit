import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createLakebasePool } from "../pool";

// ── Mocks ────────────────────────────────────────────────────────────

// Mock pg module
vi.mock("pg", () => {
  const mockQuery = vi.fn();
  const mockConnect = vi.fn();
  const mockEnd = vi.fn().mockResolvedValue(undefined);
  const mockOn = vi.fn();

  const MockPool = vi.fn((config) => ({
    query: mockQuery,
    connect: mockConnect,
    end: mockEnd,
    on: mockOn,
    options: config, // Store config for inspection
    totalCount: 3,
    idleCount: 1,
    waitingCount: 0,
  }));

  return {
    default: { Pool: MockPool },
    Pool: MockPool,
    __mockQuery: mockQuery,
    __mockConnect: mockConnect,
    __mockEnd: mockEnd,
    __mockOn: mockOn,
    __MockPool: MockPool,
  };
});

// Mock generateDatabaseCredential
vi.mock("../credentials", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../credentials")>();
  return {
    ...actual,
    generateDatabaseCredential: vi.fn(),
  };
});

// Mock telemetry - create spies for all metric instruments
const mockSpanEnd = vi.fn();
const mockSpanSetAttribute = vi.fn();
const mockSpanSetStatus = vi.fn();
const mockCounterAdd = vi.fn();
const mockHistogramRecord = vi.fn();
const mockAddCallback = vi.fn();

const mockTracer = {
  startActiveSpan: vi.fn(
    <T>(_name: string, _opts: unknown, fn: (span: unknown) => T): T => {
      const span = {
        setAttribute: mockSpanSetAttribute,
        setStatus: mockSpanSetStatus,
        end: mockSpanEnd,
        recordException: vi.fn(),
      };
      return fn(span);
    },
  ),
};

const mockMeter = {
  createCounter: vi.fn(() => ({ add: mockCounterAdd })),
  createHistogram: vi.fn(() => ({ record: mockHistogramRecord })),
  createObservableGauge: vi.fn(() => ({
    addCallback: mockAddCallback,
  })),
};

vi.mock("../telemetry", () => ({
  SpanStatusCode: { OK: 1, ERROR: 2 },
  SpanKind: { CLIENT: 3 },
  initTelemetry: vi.fn(() => ({
    tracer: mockTracer,
    meter: mockMeter,
    tokenRefreshDuration: { record: mockHistogramRecord },
    queryDuration: { record: mockHistogramRecord },
    poolErrors: { add: mockCounterAdd },
  })),
  attachPoolMetrics: vi.fn(),
}));

// ── Test suite ───────────────────────────────────────────────────────

describe("createLakebasePool", () => {
  let mockGenerateCredential: ReturnType<typeof vi.fn>;

  // Save original env vars to restore after each test
  const originalEnv: Record<string, string | undefined> = {};
  const envKeysUsed = [
    "PGHOST",
    "PGDATABASE",
    "LAKEBASE_ENDPOINT",
    "PGUSER",
    "PGPORT",
    "PGSSLMODE",
    "DATABRICKS_CLIENT_ID",
  ];

  beforeEach(async () => {
    vi.clearAllMocks();

    // Save original env vars
    for (const key of envKeysUsed) {
      originalEnv[key] = process.env[key];
    }

    // Setup environment variables
    process.env.PGHOST = "ep-test.database.us-east-1.databricks.com";
    process.env.PGDATABASE = "databricks_postgres";
    process.env.LAKEBASE_ENDPOINT =
      "projects/test-project/branches/main/endpoints/primary";
    process.env.PGUSER = "test-user@example.com";

    // Setup mock for generateDatabaseCredential
    const utils = await import("../credentials");
    mockGenerateCredential = utils.generateDatabaseCredential as any;
    mockGenerateCredential.mockResolvedValue({
      token: "test-oauth-token-12345",
      expire_time: new Date(Date.now() + 3600000).toISOString(), // 1 hour from now
    });
  });

  afterEach(() => {
    // Restore original env vars
    for (const key of envKeysUsed) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
  });

  describe("configuration", () => {
    test("should create pool with environment variables", () => {
      const pool = createLakebasePool({
        workspaceClient: {} as any,
      });

      expect(pool).toBeDefined();
      expect(pool.options.host).toBe(
        "ep-test.database.us-east-1.databricks.com",
      );
      expect(pool.options.database).toBe("databricks_postgres");
      expect(pool.options.user).toBe("test-user@example.com");
      expect(pool.options.port).toBe(5432);
    });

    test("should create pool with explicit configuration", () => {
      const pool = createLakebasePool({
        workspaceClient: {} as any,
        endpoint: "projects/my-project/branches/dev/endpoints/test",
        host: "ep-custom.database.us-west-2.databricks.com",
        database: "custom_db",
        user: "custom-user@example.com", // Explicit user overrides env
        port: 5433,
        max: 20,
      });

      expect(pool.options.host).toBe(
        "ep-custom.database.us-west-2.databricks.com",
      );
      expect(pool.options.database).toBe("custom_db");
      expect(pool.options.user).toBe("custom-user@example.com");
      expect(pool.options.port).toBe(5433);
      expect(pool.options.max).toBe(20);
    });

    test("should throw error when endpoint is missing", () => {
      delete process.env.LAKEBASE_ENDPOINT;

      expect(() =>
        createLakebasePool({
          workspaceClient: {} as any,
        }),
      ).toThrow("LAKEBASE_ENDPOINT or config.endpoint");
    });

    test("should throw error when host is missing", () => {
      delete process.env.PGHOST;

      expect(() =>
        createLakebasePool({
          workspaceClient: {} as any,
        }),
      ).toThrow("PGHOST or config.host");
    });

    test("should throw error when database is missing", () => {
      delete process.env.PGDATABASE;

      expect(() =>
        createLakebasePool({
          workspaceClient: {} as any,
        }),
      ).toThrow("PGDATABASE or config.database");
    });

    test("should throw error when user is missing", () => {
      delete process.env.PGUSER;
      delete process.env.DATABRICKS_CLIENT_ID;

      expect(() =>
        createLakebasePool({
          workspaceClient: {} as any,
        }),
      ).toThrow("PGUSER, DATABRICKS_CLIENT_ID, or config.user");
    });

    test("should use DATABRICKS_CLIENT_ID as fallback for user", () => {
      delete process.env.PGUSER;
      process.env.DATABRICKS_CLIENT_ID = "service-principal-123";

      const pool = createLakebasePool({
        workspaceClient: {} as any,
      });

      expect(pool.options.user).toBe("service-principal-123");
    });

    test("should use default values for optional config", () => {
      const pool = createLakebasePool({
        workspaceClient: {} as any,
      });

      expect(pool.options.port).toBe(5432);
      expect(pool.options.max).toBe(10);
      expect(pool.options.idleTimeoutMillis).toBe(30000);
      expect(pool.options.connectionTimeoutMillis).toBe(10000);
    });

    test("should configure SSL based on sslMode", () => {
      const pool = createLakebasePool({
        workspaceClient: {} as any,
        sslMode: "require",
      });

      expect(pool.options.ssl).toEqual({ rejectUnauthorized: true });
    });

    test("should allow custom SSL configuration", () => {
      const customSSL = { rejectUnauthorized: false, ca: "custom-ca" };
      const pool = createLakebasePool({
        workspaceClient: {} as any,
        ssl: customSSL,
      });

      expect(pool.options.ssl).toEqual(customSSL);
    });

    test("should throw on invalid PGSSLMODE", () => {
      process.env.PGSSLMODE = "verify-full";

      expect(() =>
        createLakebasePool({
          workspaceClient: {} as any,
        }),
      ).toThrow("one of: require, disable, prefer");
    });

    test("should accept valid PGSSLMODE values", () => {
      for (const mode of ["require", "disable", "prefer"]) {
        process.env.PGSSLMODE = mode;

        expect(() =>
          createLakebasePool({
            workspaceClient: {} as any,
          }),
        ).not.toThrow();
      }
    });
  });

  describe("password callback", () => {
    test("should configure password as async function", () => {
      const pool = createLakebasePool({
        workspaceClient: {} as any,
      });

      expect(typeof pool.options.password).toBe("function");
    });

    test("should fetch OAuth token when password callback is invoked", async () => {
      const workspaceClient = {
        test: "client",
        config: { host: "test" },
      } as any;
      const pool = createLakebasePool({
        workspaceClient,
        endpoint: "projects/test/branches/main/endpoints/primary",
      });

      // Invoke the password callback
      const passwordFn = pool.options.password as () => Promise<string>;
      const password = await passwordFn();

      expect(mockGenerateCredential).toHaveBeenCalledWith(workspaceClient, {
        endpoint: "projects/test/branches/main/endpoints/primary",
      });
      expect(password).toBe("test-oauth-token-12345");
    });

    test("should cache OAuth token for subsequent calls", async () => {
      const workspaceClient = { config: { host: "test" } } as any;
      const pool = createLakebasePool({
        workspaceClient,
      });

      const passwordFn = pool.options.password as () => Promise<string>;

      // First call - should fetch token
      const password1 = await passwordFn();
      expect(mockGenerateCredential).toHaveBeenCalledTimes(1);

      // Second call - should use cached token
      const password2 = await passwordFn();
      expect(mockGenerateCredential).toHaveBeenCalledTimes(1); // Still 1
      expect(password2).toBe(password1);
    });

    test("should refresh token when it expires", async () => {
      const workspaceClient = { config: { host: "test" } } as any;

      // First token expires in 1 minute (within buffer)
      mockGenerateCredential.mockResolvedValueOnce({
        token: "expiring-token",
        expire_time: new Date(Date.now() + 60000).toISOString(),
      });

      // Second token expires in 1 hour
      mockGenerateCredential.mockResolvedValueOnce({
        token: "new-token",
        expire_time: new Date(Date.now() + 3600000).toISOString(),
      });

      const pool = createLakebasePool({
        workspaceClient,
      });

      const passwordFn = pool.options.password as () => Promise<string>;

      // First call - get expiring token
      const password1 = await passwordFn();
      expect(password1).toBe("expiring-token");
      expect(mockGenerateCredential).toHaveBeenCalledTimes(1);

      // Second call - token is expiring, should refresh
      const password2 = await passwordFn();
      expect(password2).toBe("new-token");
      expect(mockGenerateCredential).toHaveBeenCalledTimes(2);
    });

    test("should handle token fetch errors", async () => {
      const workspaceClient = { config: { host: "test" } } as any;

      mockGenerateCredential.mockRejectedValue(new Error("Token fetch failed"));

      const pool = createLakebasePool({
        workspaceClient,
      });

      const passwordFn = pool.options.password as () => Promise<string>;
      await expect(passwordFn()).rejects.toThrow("Token fetch failed");
    });

    test("should deduplicate concurrent token refresh requests", async () => {
      const workspaceClient = { config: { host: "test" } } as any;

      // Make the credential generation slow
      mockGenerateCredential.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  token: "deduped-token",
                  expire_time: new Date(Date.now() + 3600000).toISOString(),
                }),
              50,
            ),
          ),
      );

      const pool = createLakebasePool({
        workspaceClient,
      });

      const passwordFn = pool.options.password as () => Promise<string>;

      // Fire multiple concurrent calls
      const [p1, p2, p3] = await Promise.all([
        passwordFn(),
        passwordFn(),
        passwordFn(),
      ]);

      // Only one API call should have been made
      expect(mockGenerateCredential).toHaveBeenCalledTimes(1);
      expect(p1).toBe("deduped-token");
      expect(p2).toBe("deduped-token");
      expect(p3).toBe("deduped-token");
    });
  });

  describe("workspace client", () => {
    test("should use provided workspace client", () => {
      const workspaceClient = { config: { host: "test" } } as any;
      const pool = createLakebasePool({
        workspaceClient,
      });

      expect(pool).toBeDefined();
    });

    test("should fallback to SDK default auth when workspace client not provided", async () => {
      const pool = createLakebasePool({
        // No workspace client provided - should use SDK default auth chain
      });

      // Pool should be created successfully
      expect(pool).toBeDefined();
      expect(pool.options.password).toBeDefined();
      expect(typeof pool.options.password).toBe("function");
    });
  });

  describe("pool behavior", () => {
    test("should register error handler", () => {
      const pool = createLakebasePool({
        workspaceClient: {} as any,
      });

      // Pool should have on method for error handling
      expect(pool.on).toBeDefined();
      expect(typeof pool.on).toBe("function");
    });

    test("should return pg.Pool instance", () => {
      const pool = createLakebasePool({
        workspaceClient: {} as any,
      });

      // Standard pg.Pool methods should be available
      expect(pool.query).toBeDefined();
      expect(pool.connect).toBeDefined();
      expect(pool.end).toBeDefined();
      expect(typeof pool.query).toBe("function");
      expect(typeof pool.connect).toBe("function");
      expect(typeof pool.end).toBe("function");
    });
  });

  describe("ORM compatibility patterns", () => {
    test("should work with Drizzle pattern", () => {
      const pool = createLakebasePool({
        workspaceClient: {} as any,
      });

      // Drizzle expects { client: pool }
      const drizzleConfig = { client: pool };
      expect(drizzleConfig.client).toBe(pool);
      expect(typeof drizzleConfig.client.query).toBe("function");
    });

    test("should work with Prisma adapter pattern", () => {
      const pool = createLakebasePool({
        workspaceClient: {} as any,
      });

      // Prisma expects PrismaPg(pool)
      // Mock PrismaPg adapter
      const mockPrismaPg = (pgPool: any) => ({ pool: pgPool });
      const adapter = mockPrismaPg(pool);

      expect(adapter.pool).toBe(pool);
    });

    test("should expose standard pg.Pool interface", () => {
      const pool = createLakebasePool({
        workspaceClient: {} as any,
      });

      // Standard pg.Pool methods
      expect(pool.query).toBeDefined();
      expect(pool.connect).toBeDefined();
      expect(pool.end).toBeDefined();
      expect(pool.on).toBeDefined();

      // Options should be accessible
      expect(pool.options).toBeDefined();
      expect(pool.options.host).toBeDefined();
      expect(pool.options.database).toBeDefined();
    });
  });

  describe("native password authentication", () => {
    test("should use static password when provided", () => {
      const pool = createLakebasePool({
        password: "my-static-password",
        host: "ep-test.database.us-east-1.databricks.com",
        database: "databricks_postgres",
      });

      expect(pool.options.password).toBe("my-static-password");
    });

    test("should prioritize password over OAuth when both provided", () => {
      const pool = createLakebasePool({
        password: "my-password",
        workspaceClient: {} as any,
        endpoint: "projects/test/branches/main/endpoints/primary",
      });

      expect(pool.options.password).toBe("my-password");
    });

    test("should support custom password callback function", async () => {
      const customCallback = vi.fn(async () => "custom-token");

      const pool = createLakebasePool({
        password: customCallback,
        host: "ep-test.database.us-east-1.databricks.com",
        database: "databricks_postgres",
      });

      expect(typeof pool.options.password).toBe("function");
      const passwordFn = pool.options.password as () => Promise<string>;
      const result = await passwordFn();

      expect(result).toBe("custom-token");
      expect(customCallback).toHaveBeenCalled();
    });

    test("should not require endpoint when password is provided", () => {
      delete process.env.LAKEBASE_ENDPOINT;

      expect(() =>
        createLakebasePool({
          password: "my-password",
          host: "ep-test.database.us-east-1.databricks.com",
          database: "databricks_postgres",
        }),
      ).not.toThrow();
    });

    test("should not call OAuth token generation when password is provided", async () => {
      const pool = createLakebasePool({
        password: "static-password",
        host: "ep-test.database.us-east-1.databricks.com",
        database: "databricks_postgres",
      });

      // Simulate pg calling the password - should return the string directly
      expect(pool.options.password).toBe("static-password");

      // OAuth credential generation should not have been called
      expect(mockGenerateCredential).not.toHaveBeenCalled();
    });
  });

  describe("telemetry", () => {
    test("should initialize telemetry", async () => {
      const { initTelemetry } = await import("../telemetry");

      createLakebasePool({
        workspaceClient: {} as any,
      });

      expect(initTelemetry).toHaveBeenCalled();
    });

    test("should record token refresh duration on successful fetch", async () => {
      const workspaceClient = { config: { host: "test" } } as any;
      const pool = createLakebasePool({
        workspaceClient,
      });

      const passwordFn = pool.options.password as () => Promise<string>;
      await passwordFn();

      // Token refresh duration should be recorded (histogram captures count implicitly)
      expect(mockHistogramRecord).toHaveBeenCalledWith(expect.any(Number));
    });

    test("should set span attributes on token refresh", async () => {
      const workspaceClient = { config: { host: "test" } } as any;
      const pool = createLakebasePool({
        workspaceClient,
      });

      const passwordFn = pool.options.password as () => Promise<string>;
      await passwordFn();

      // Span should have token expiration attribute
      expect(mockSpanSetAttribute).toHaveBeenCalledWith(
        "lakebase.token.expires_at",
        expect.any(String),
      );
      expect(mockSpanSetStatus).toHaveBeenCalledWith({
        code: 1, // SpanStatusCode.OK
      });
      expect(mockSpanEnd).toHaveBeenCalled();
    });

    test("should wrap pool.query to add telemetry tracking", () => {
      const pool = createLakebasePool({
        workspaceClient: {} as any,
      });

      // pool.query should be our wrapped function
      expect(typeof pool.query).toBe("function");
      expect(pool.query.name).toBe("queryWithTelemetry");
    });
  });

  describe("logger injection", () => {
    test("should default to error-only logging when no logger provided", () => {
      const consoleDebugSpy = vi.spyOn(console, "debug");
      const consoleInfoSpy = vi.spyOn(console, "info");
      const consoleWarnSpy = vi.spyOn(console, "warn");
      const consoleErrorSpy = vi.spyOn(console, "error");

      const pool = createLakebasePool({
        workspaceClient: {} as any,
      });

      expect(pool).toBeDefined();
      // Default behavior: only errors are logged
      expect(consoleDebugSpy).not.toHaveBeenCalled();
      expect(consoleInfoSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
      // Error logging would happen on actual errors

      consoleDebugSpy.mockRestore();
      consoleInfoSpy.mockRestore();
      consoleWarnSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });

    test("should use injected Logger instance", () => {
      const mockLogger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };

      const pool = createLakebasePool({
        workspaceClient: {} as any,
        logger: mockLogger,
      });

      expect(pool).toBeDefined();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining("Created Lakebase connection pool"),
        expect.any(String),
        expect.any(String),
        expect.any(String),
      );
    });

    test("should use LoggerConfig with selective levels", () => {
      const consoleDebugSpy = vi.spyOn(console, "debug");
      const consoleInfoSpy = vi.spyOn(console, "info");
      const consoleWarnSpy = vi.spyOn(console, "warn");
      const consoleErrorSpy = vi.spyOn(console, "error");

      const pool = createLakebasePool({
        workspaceClient: {} as any,
        logger: { debug: true, info: false, warn: false, error: true },
      });

      expect(pool).toBeDefined();
      // Debug should be logged
      expect(consoleDebugSpy).toHaveBeenCalledWith(
        expect.stringContaining("Created Lakebase connection pool"),
        expect.any(String),
        expect.any(String),
        expect.any(String),
      );
      // Info and warn should not be called
      expect(consoleInfoSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();

      consoleDebugSpy.mockRestore();
      consoleInfoSpy.mockRestore();
      consoleWarnSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });

    test("should use LoggerConfig with all levels enabled", () => {
      const consoleDebugSpy = vi.spyOn(console, "debug");
      const consoleInfoSpy = vi.spyOn(console, "info");
      const consoleWarnSpy = vi.spyOn(console, "warn");
      const consoleErrorSpy = vi.spyOn(console, "error");

      const pool = createLakebasePool({
        workspaceClient: {} as any,
        logger: { debug: true, info: true, warn: true, error: true },
      });

      expect(pool).toBeDefined();
      expect(consoleDebugSpy).toHaveBeenCalled();

      consoleDebugSpy.mockRestore();
      consoleInfoSpy.mockRestore();
      consoleWarnSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });

    test("should use LoggerConfig with all levels disabled", () => {
      const consoleDebugSpy = vi.spyOn(console, "debug");
      const consoleInfoSpy = vi.spyOn(console, "info");
      const consoleWarnSpy = vi.spyOn(console, "warn");
      const consoleErrorSpy = vi.spyOn(console, "error");

      const pool = createLakebasePool({
        workspaceClient: {} as any,
        logger: { debug: false, info: false, warn: false, error: false },
      });

      expect(pool).toBeDefined();
      expect(consoleDebugSpy).not.toHaveBeenCalled();
      expect(consoleInfoSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).not.toHaveBeenCalled();

      consoleDebugSpy.mockRestore();
      consoleInfoSpy.mockRestore();
      consoleWarnSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    });

    test("should pass resolved logger to error handlers", async () => {
      const { attachPoolMetrics } = await import("../telemetry");

      createLakebasePool({
        workspaceClient: {} as any,
        logger: { debug: true, error: true },
      });

      // Verify attachPoolMetrics was called with a resolved logger
      expect(attachPoolMetrics).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          debug: expect.any(Function),
          info: expect.any(Function),
          warn: expect.any(Function),
          error: expect.any(Function),
        }),
      );
    });
  });
});
