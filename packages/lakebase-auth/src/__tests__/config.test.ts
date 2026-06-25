import type { WorkspaceClient } from "@databricks/sdk-experimental";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mockMe = vi.fn();

// Mock the SDK so getWorkspaceClient() can construct a client and
// getUsernameWithApiLookup() can exercise the currentUser.me() fallback.
vi.mock("@databricks/sdk-experimental", () => ({
  WorkspaceClient: vi
    .fn()
    .mockImplementation(() => ({ currentUser: { me: mockMe } })),
}));

import { WorkspaceClient as MockWorkspaceClient } from "@databricks/sdk-experimental";
import {
  getUsernameSync,
  getUsernameWithApiLookup,
  getWorkspaceClient,
  mapSslConfig,
  parseConfig,
} from "../config";

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
  for (const key of ENV_KEYS) {
    original[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

describe("mapSslConfig", () => {
  test.each(["verify-full", "verify-ca", "require", "prefer"] as const)(
    "maps %s to certificate verification",
    (mode) => {
      expect(mapSslConfig(mode)).toEqual({ rejectUnauthorized: true });
    },
  );

  test("maps disable to false", () => {
    expect(mapSslConfig("disable")).toBe(false);
  });

  test("populates the Bun SNI server name from a DNS host", () => {
    expect(mapSslConfig("verify-full", "ep-test.databricks.com")).toEqual({
      rejectUnauthorized: true,
      serverName: "ep-test.databricks.com",
    });
  });

  test("omits SNI server name for IP-literal hosts", () => {
    expect(mapSslConfig("require", "10.0.0.5")).toEqual({
      rejectUnauthorized: true,
    });
    expect(mapSslConfig("require", "::1")).toEqual({
      rejectUnauthorized: true,
    });
  });

  test("never sets SNI when SSL is disabled", () => {
    expect(mapSslConfig("disable", "ep-test.databricks.com")).toBe(false);
  });
});

describe("parseConfig", () => {
  const base = {
    host: "ep.databricks.com",
    database: "databricks_postgres",
    endpoint: "projects/p/branches/b/endpoints/e",
  };

  test("reads connection essentials from explicit config", () => {
    const parsed = parseConfig(base);
    expect(parsed).toMatchObject({
      host: "ep.databricks.com",
      database: "databricks_postgres",
      endpoint: "projects/p/branches/b/endpoints/e",
      port: 5432,
      sslMode: "verify-full",
    });
  });

  test("falls back to environment variables", () => {
    process.env.PGHOST = "env-host";
    process.env.PGDATABASE = "env-db";
    process.env.LAKEBASE_ENDPOINT = "env-endpoint";
    process.env.PGPORT = "6543";
    process.env.PGSSLMODE = "require";

    const parsed = parseConfig();
    expect(parsed.host).toBe("env-host");
    expect(parsed.database).toBe("env-db");
    expect(parsed.endpoint).toBe("env-endpoint");
    expect(parsed.port).toBe(6543);
    expect(parsed.sslMode).toBe("require");
  });

  test("throws when neither endpoint nor password is provided", () => {
    expect(() =>
      parseConfig({ host: base.host, database: base.database }),
    ).toThrow("LAKEBASE_ENDPOINT or config.endpoint");
  });

  test("allows a missing endpoint when a native password is provided", () => {
    const parsed = parseConfig({
      host: base.host,
      database: base.database,
      password: "secret",
    });
    expect(parsed.endpoint).toBeUndefined();
  });

  test("throws when the host is missing", () => {
    expect(() =>
      parseConfig({ database: base.database, endpoint: base.endpoint }),
    ).toThrow("PGHOST or config.host");
  });

  test("throws when the database is missing", () => {
    expect(() =>
      parseConfig({ host: base.host, endpoint: base.endpoint }),
    ).toThrow("PGDATABASE or config.database");
  });

  test("throws when PGPORT is not a number", () => {
    process.env.PGPORT = "not-a-number";
    expect(() => parseConfig(base)).toThrow("port");
  });

  test("throws on an invalid sslMode", () => {
    expect(() =>
      parseConfig({ ...base, sslMode: "wide-open" as never }),
    ).toThrow("one of: verify-full, verify-ca, require, prefer, disable");
  });

  test("passes through an explicit ssl config", () => {
    const ssl = { rejectUnauthorized: false };
    expect(parseConfig({ ...base, ssl }).ssl).toBe(ssl);
  });
});

describe("getWorkspaceClient", () => {
  test("returns an explicitly provided workspace client", () => {
    const explicit = { sentinel: true } as unknown as WorkspaceClient;
    expect(getWorkspaceClient({ workspaceClient: explicit })).toBe(explicit);
    expect(MockWorkspaceClient).not.toHaveBeenCalled();
  });

  test("constructs a client from the SDK default auth chain otherwise", () => {
    const client = getWorkspaceClient({});
    expect(MockWorkspaceClient).toHaveBeenCalledWith({});
    expect(client).toBeDefined();
  });
});

describe("getUsernameSync", () => {
  test("prefers config.user", () => {
    process.env.PGUSER = "env-user";
    expect(getUsernameSync({ user: "config-user" })).toBe("config-user");
  });

  test("falls back to PGUSER", () => {
    process.env.PGUSER = "env-user";
    expect(getUsernameSync({})).toBe("env-user");
  });

  test("falls back to DATABRICKS_CLIENT_ID", () => {
    process.env.DATABRICKS_CLIENT_ID = "sp-123";
    expect(getUsernameSync({})).toBe("sp-123");
  });

  test("throws when nothing resolves", () => {
    expect(() => getUsernameSync({})).toThrow(
      "config.user, PGUSER or DATABRICKS_CLIENT_ID",
    );
  });
});

describe("getUsernameWithApiLookup", () => {
  test("returns the synchronously resolved username without an API call", async () => {
    await expect(getUsernameWithApiLookup({ user: "sync-user" })).resolves.toBe(
      "sync-user",
    );
    expect(mockMe).not.toHaveBeenCalled();
  });

  test("falls back to the workspace API when sync resolution fails", async () => {
    mockMe.mockResolvedValue({ userName: "api-user@example.com" });
    await expect(getUsernameWithApiLookup({})).resolves.toBe(
      "api-user@example.com",
    );
    expect(mockMe).toHaveBeenCalledTimes(1);
  });

  test("returns undefined when the API lookup throws", async () => {
    mockMe.mockRejectedValue(new Error("network down"));
    await expect(getUsernameWithApiLookup({})).resolves.toBeUndefined();
  });

  test("returns undefined when the API has no userName", async () => {
    mockMe.mockResolvedValue({ userName: null });
    await expect(getUsernameWithApiLookup({})).resolves.toBeUndefined();
  });
});
