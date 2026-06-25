import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createTelemetryFetchCredential,
  getLakebaseOrmConfig,
  loggerToOnLog,
} from "../pool-config";
import type { DriverTelemetry } from "../telemetry";
import { createTokenRefreshCallback } from "../token-refresh";

// Keep the real auth logic, but stub the network-bound credential generation
// and workspace-client creation.
vi.mock("@databricks/lakebase-auth", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@databricks/lakebase-auth")>();
  return {
    ...actual,
    generateDatabaseCredential: vi.fn(),
    getWorkspaceClient: vi.fn(() => ({ config: { host: "test" } })),
  };
});

import {
  generateDatabaseCredential,
  getWorkspaceClient,
} from "@databricks/lakebase-auth";

const mockGenerate = vi.mocked(generateDatabaseCredential);
const mockGetWorkspaceClient = vi.mocked(getWorkspaceClient);

/** A telemetry double whose tracer simply runs the active-span callback. */
function fakeTelemetry(): DriverTelemetry {
  return {
    tracer: {
      startActiveSpan: <T>(_n: string, _o: unknown, fn: (s: never) => T): T =>
        fn({
          setAttribute: vi.fn(),
          setStatus: vi.fn(),
          end: vi.fn(),
          recordException: vi.fn(),
        } as never),
    },
    meter: {},
    tokenRefreshDuration: { record: vi.fn() },
    queryDuration: { record: vi.fn() },
    poolErrors: { add: vi.fn() },
  } as unknown as DriverTelemetry;
}

const ENV_KEYS = [
  "PGHOST",
  "PGDATABASE",
  "LAKEBASE_ENDPOINT",
  "PGUSER",
  "PGPORT",
  "PGSSLMODE",
  "DATABRICKS_CLIENT_ID",
] as const;
const original: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of ENV_KEYS) original[key] = process.env[key];
  process.env.PGHOST = "ep-test.databricks.com";
  process.env.PGDATABASE = "databricks_postgres";
  process.env.LAKEBASE_ENDPOINT = "projects/p/branches/b/endpoints/e";
  process.env.PGUSER = "user@example.com";
  mockGenerate.mockResolvedValue({
    token: "oauth-token",
    expire_time: new Date(Date.now() + 3_600_000).toISOString(),
  });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

describe("loggerToOnLog", () => {
  test("returns undefined without a logger", () => {
    expect(loggerToOnLog(undefined)).toBeUndefined();
  });

  test("bridges structured log calls to the matching logger level", () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const onLog = loggerToOnLog(logger);

    onLog?.("warn", "msg %s", "arg");
    expect(logger.warn).toHaveBeenCalledWith("msg %s", "arg");
    onLog?.("error", "boom");
    expect(logger.error).toHaveBeenCalledWith("boom");
  });
});

describe("getLakebaseOrmConfig", () => {
  test("renames user to username and normalizes a boolean ssl (disable)", () => {
    const cfg = getLakebaseOrmConfig({
      password: "static",
      sslMode: "disable",
    });

    expect(cfg.username).toBe("user@example.com");
    expect("user" in cfg).toBe(false);
    expect(cfg.password).toBe("static");
    expect(cfg.ssl).toBe(false);
  });

  test("normalizes an object ssl to just rejectUnauthorized", () => {
    const cfg = getLakebaseOrmConfig({
      password: "static",
      sslMode: "verify-full",
    });

    expect(cfg.ssl).toEqual({ rejectUnauthorized: true });
  });

  test("exposes a password callback for the OAuth path", () => {
    const cfg = getLakebaseOrmConfig({
      workspaceClient: {} as never,
      refresh: "lazy",
    });

    expect(cfg.username).toBe("user@example.com");
    expect(typeof cfg.password).toBe("function");
  });
});

describe("createTelemetryFetchCredential", () => {
  test("fetches, traces, and maps the credential", async () => {
    const telemetry = fakeTelemetry();
    const fetchCredential = createTelemetryFetchCredential({
      userConfig: { workspaceClient: {} as never },
      endpoint: "projects/p/branches/b/endpoints/e",
      telemetry,
    });

    const credential = await fetchCredential();
    expect(credential.token).toBe("oauth-token");
    expect(typeof credential.expiresAt).toBe("number");
    expect(telemetry.tokenRefreshDuration.record).toHaveBeenCalledWith(
      expect.any(Number),
    );
  });

  test("logs and rethrows when the workspace client cannot be created", async () => {
    mockGetWorkspaceClient.mockImplementationOnce(() => {
      throw new Error("no auth");
    });
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const fetchCredential = createTelemetryFetchCredential({
      userConfig: {}, // no workspaceClient -> getWorkspaceClient is invoked
      endpoint: "projects/p/branches/b/endpoints/e",
      telemetry: fakeTelemetry(),
      logger,
    });

    await expect(fetchCredential()).rejects.toThrow("no auth");
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("workspace client"),
      expect.any(Error),
    );
  });

  test("logs and rethrows when credential generation fails", async () => {
    mockGenerate.mockRejectedValueOnce(new Error("api down"));
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const fetchCredential = createTelemetryFetchCredential({
      userConfig: { workspaceClient: {} as never },
      endpoint: "projects/p/branches/b/endpoints/e",
      telemetry: fakeTelemetry(),
      logger,
    });

    await expect(fetchCredential()).rejects.toThrow("api down");
    expect(logger.error).toHaveBeenCalled();
  });
});

describe("createTokenRefreshCallback (deprecated)", () => {
  test("returns a lazy password callback that resolves to the token", async () => {
    const password = createTokenRefreshCallback({
      userConfig: { workspaceClient: {} as never },
      endpoint: "projects/p/branches/b/endpoints/e",
      telemetry: fakeTelemetry(),
    });

    // Lazy: nothing fetched until the callback is invoked.
    expect(mockGenerate).not.toHaveBeenCalled();
    await expect(password()).resolves.toBe("oauth-token");
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });

  test("deduplicates concurrent callback invocations", async () => {
    mockGenerate.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                token: "deduped",
                expire_time: new Date(Date.now() + 3_600_000).toISOString(),
              }),
            10,
          ),
        ),
    );

    const password = createTokenRefreshCallback({
      userConfig: { workspaceClient: {} as never },
      endpoint: "projects/p/branches/b/endpoints/e",
      telemetry: fakeTelemetry(),
    });

    const [a, b, c] = await Promise.all([password(), password(), password()]);
    expect([a, b, c]).toEqual(["deduped", "deduped", "deduped"]);
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });
});
