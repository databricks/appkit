import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ConfigCheckContext,
  checkAuth,
  checkConfig,
  sanitizeHost,
  validateHost,
} from "./checks";
import type { ResourceTarget } from "./types";

const { mockGetServiceClient, mockGetProfileHost } = vi.hoisted(() => ({
  mockGetServiceClient: vi.fn(),
  // Defaults to "profile declares no host", so the conflict check stays inert
  // unless a test opts in.
  mockGetProfileHost: vi.fn(async () => undefined as string | undefined),
}));
vi.mock("./databricks-client", () => ({
  SdkNotInstalledError: class SdkNotInstalledError extends Error {},
  getServiceClient: mockGetServiceClient,
  getProfileHost: mockGetProfileHost,
}));

function target(overrides: Partial<ResourceTarget> = {}): ResourceTarget {
  return {
    type: "sql_warehouse",
    resourceKey: "sql-warehouse",
    alias: "SQL Warehouse",
    plugin: "analytics",
    requiredPermission: "CAN_USE",
    required: true,
    envVars: ["DOCTOR_TEST_ENV"],
    fieldValues: {},
    ...overrides,
  };
}

describe("checkConfig", () => {
  const saved = { ...process.env };

  /** Default context: `.env`, with no deploy wiring declared. */
  function ctx(overrides: Partial<ConfigCheckContext> = {}) {
    return {
      envFile: ".env",
      wiredEnvVars: new Set<string>(),
      ...overrides,
    };
  }

  beforeEach(() => {
    delete process.env.DOCTOR_TEST_ENV;
    delete process.env.DOCTOR_TEST_ENV_2;
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it("errors when a required resource's env var is unset", async () => {
    const result = await checkConfig(target(), ctx());
    expect(result.status).toBe("error");
    expect(result.code).toBe("ENV_MISSING");
  });

  it("warns (not errors) when an optional resource's env var is unset", async () => {
    const result = await checkConfig(target({ required: false }), ctx());
    expect(result.status).toBe("warn");
    expect(result.code).toBe("ENV_MISSING_OPTIONAL");
  });

  it("passes an unfilled-looking value (existence check is the authority)", async () => {
    process.env.DOCTOR_TEST_ENV = "your_sql_warehouse_id";
    const result = await checkConfig(target(), ctx());
    expect(result.status).toBe("ok");
  });

  it("treats an empty string as missing", async () => {
    process.env.DOCTOR_TEST_ENV = "   ";
    const result = await checkConfig(target(), ctx());
    expect(result.status).toBe("error");
    expect(result.code).toBe("ENV_MISSING");
  });

  it("reports all missing env vars when several are unset", async () => {
    const result = await checkConfig(
      target({ envVars: ["DOCTOR_TEST_ENV", "DOCTOR_TEST_ENV_2"] }),
      ctx(),
    );
    expect(result.status).toBe("error");
    expect(result.detail).toContain("DOCTOR_TEST_ENV");
    expect(result.detail).toContain("DOCTOR_TEST_ENV_2");
  });

  it("names the env file, so it can't be read as app.yaml/databricks.yml", async () => {
    const result = await checkConfig(target(), ctx());
    expect(result.detail).toBe("DOCTOR_TEST_ENV is not set in `.env`");
  });

  it("names the --env-file path when one was used", async () => {
    const result = await checkConfig(target(), ctx({ envFile: ".env.local" }));
    expect(result.detail).toContain("`.env.local`");
    expect(result.detail).not.toContain("`.env`");
  });

  it("names the --env-file path in the hint too", async () => {
    // Unwired, so a hint is produced and should point at the same file.
    const result = await checkConfig(target(), ctx({ envFile: ".env.local" }));
    expect(result.hint).toContain("`.env.local`");
  });

  it("keeps the optional marker alongside the file name", async () => {
    const result = await checkConfig(target({ required: false }), ctx());
    expect(result.detail).toBe(
      "DOCTOR_TEST_ENV is not set in `.env` (optional)",
    );
  });

  it("gives no hint at all when app.yaml already wires the var", async () => {
    const result = await checkConfig(
      target(),
      ctx({ wiredEnvVars: new Set(["DOCTOR_TEST_ENV"]) }),
    );
    // Nothing to add: deploy wiring is correct, and "set it" is already the
    // detail line, so a hint would only restate it.
    expect(result.hint).toBeUndefined();
  });

  it("still advises wiring when app.yaml doesn't cover every missing var", async () => {
    const result = await checkConfig(
      target({ envVars: ["DOCTOR_TEST_ENV", "DOCTOR_TEST_ENV_2"] }),
      ctx({ wiredEnvVars: new Set(["DOCTOR_TEST_ENV"]) }),
    );
    expect(result.hint).toContain("app.yaml + databricks.yml");
  });
});

describe("validateHost", () => {
  it("accepts an unset host (SDK auth chain takes over)", () => {
    expect(validateHost(undefined)).toBeNull();
    expect(validateHost("")).toBeNull();
  });

  it("accepts a real workspace URL", () => {
    expect(validateHost("https://foo.cloud.databricks.com")).toBeNull();
    expect(validateHost("https://adb-123.4.azuredatabricks.net")).toBeNull();
  });

  it("rejects the unfilled template placeholder https://...", () => {
    expect(validateHost("https://...")).toMatch(/placeholder/i);
  });

  it("rejects a non-URL value", () => {
    expect(validateHost("not-a-url")).toMatch(/not a valid URL/i);
  });

  it("rejects a non-http(s) scheme", () => {
    expect(validateHost("ftp://foo.databricks.com")).toMatch(/http/i);
  });
});

describe("sanitizeHost", () => {
  it("passes through an unset or credential-free host unchanged", () => {
    expect(sanitizeHost(undefined)).toBeUndefined();
    expect(sanitizeHost("https://foo.cloud.databricks.com")).toBe(
      "https://foo.cloud.databricks.com",
    );
  });

  it("strips embedded userinfo (user:pass@) so it can't leak", () => {
    const cleaned = sanitizeHost(
      "https://user:secret@workspace.databricks.com",
    );
    expect(cleaned).not.toContain("secret");
    expect(cleaned).not.toContain("user");
    expect(cleaned).toContain("workspace.databricks.com");
  });

  it("leaves a non-URL value as-is (nothing to strip)", () => {
    expect(sanitizeHost("not-a-url")).toBe("not-a-url");
  });
});

describe("checkAuth", () => {
  const savedHost = process.env.DATABRICKS_HOST;

  afterEach(() => {
    mockGetServiceClient.mockReset();
    mockGetProfileHost.mockReset();
    mockGetProfileHost.mockResolvedValue(undefined);
    if (savedHost === undefined) delete process.env.DATABRICKS_HOST;
    else process.env.DATABRICKS_HOST = savedHost;
  });

  it("ok + returns the client when currentUser.me() succeeds", async () => {
    process.env.DATABRICKS_HOST = "https://foo.cloud.databricks.com";
    const client = { currentUser: { me: async () => ({ userName: "sp-1" }) } };
    mockGetServiceClient.mockResolvedValue({ client });

    const { result, client: returned } = await checkAuth({});
    expect(result.status).toBe("ok");
    expect(result.code).toBe("AUTH_OK");
    expect(result.detail).toContain("sp-1");
    expect(returned).toBe(client); // handed to the live layers
  });

  it("stores the sanitized host (no embedded credentials) in the result", async () => {
    process.env.DATABRICKS_HOST =
      "https://user:secret@foo.cloud.databricks.com";
    const client = { currentUser: { me: async () => ({ userName: "sp-1" }) } };
    mockGetServiceClient.mockResolvedValue({ client });

    const { result } = await checkAuth({});
    expect(result.host).not.toContain("secret");
    expect(result.host).toContain("foo.cloud.databricks.com");
  });

  it("errors HOST_INVALID before touching the SDK", async () => {
    process.env.DATABRICKS_HOST = "https://...";
    const { result, client } = await checkAuth({});
    expect(result.status).toBe("error");
    expect(result.code).toBe("HOST_INVALID");
    expect(client).toBeUndefined();
    expect(mockGetServiceClient).not.toHaveBeenCalled();
  });

  it("errors SDK_NOT_INSTALLED when the bridge reports the SDK is absent", async () => {
    process.env.DATABRICKS_HOST = "https://foo.cloud.databricks.com";
    const { SdkNotInstalledError } = await import("./databricks-client");
    mockGetServiceClient.mockRejectedValue(new SdkNotInstalledError());

    const { result } = await checkAuth({});
    expect(result.status).toBe("error");
    expect(result.code).toBe("SDK_NOT_INSTALLED");
  });

  it("errors AUTH_FAILED on any other auth error", async () => {
    process.env.DATABRICKS_HOST = "https://foo.cloud.databricks.com";
    mockGetServiceClient.mockRejectedValue(new Error("something odd"));

    const { result } = await checkAuth({});
    expect(result.status).toBe("error");
    expect(result.code).toBe("AUTH_FAILED");
    // detail stays a short headline; the raw message is carried separately.
    expect(result.detail).toBe("authentication failed");
    expect(result.raw).toContain("something odd");
    expect(result.hint).toBeUndefined(); // unrecognized failure → no guess
  });

  it("fails (not hangs) when currentUser.me() never responds", async () => {
    vi.useFakeTimers();
    process.env.DATABRICKS_HOST = "https://foo.cloud.databricks.com";
    // Client resolves, but the live me() call never settles.
    mockGetServiceClient.mockResolvedValue({
      client: { currentUser: { me: () => new Promise(() => {}) } },
    });

    const authPromise = checkAuth({});
    await vi.advanceTimersByTimeAsync(10_000);
    const { result } = await authPromise;
    expect(result.status).toBe("error");
    expect(result.code).toBe("AUTH_FAILED");
    expect(result.raw).toMatch(/timed out/i);
    vi.useRealTimers();
  });

  it("hints to reauthenticate on an expired/failed CLI token (real SDK message)", async () => {
    process.env.DATABRICKS_HOST = "https://foo.cloud.databricks.com";
    mockGetServiceClient.mockRejectedValue(
      new Error(
        "default auth: databricks-cli: cannot get access token: Command failed: databricks auth token",
      ),
    );

    const { result } = await checkAuth({ profile: "prod" });
    expect(result.hint).toContain("databricks auth login --profile prod");
    expect(result.hint).toMatch(/confirm the profile\/host/i);
  });

  it("hints about a missing profile (real SDK message)", async () => {
    process.env.DATABRICKS_HOST = "https://foo.cloud.databricks.com";
    mockGetServiceClient.mockRejectedValue(
      new Error("resolve: ~/.databrickscfg has no nope profile configured"),
    );

    const { result } = await checkAuth({});
    expect(result.hint).toContain("databricks auth login");
    expect(result.hint).toMatch(/--profile/i);
  });

  it("reports the profile from DATABRICKS_CONFIG_PROFILE when --profile is unset", async () => {
    process.env.DATABRICKS_HOST = "https://foo.cloud.databricks.com";
    process.env.DATABRICKS_CONFIG_PROFILE = "from-env";
    const client = { currentUser: { me: async () => ({ userName: "u" }) } };
    mockGetServiceClient.mockResolvedValue({ client });
    try {
      const { result } = await checkAuth({});
      expect(result.profile).toBe("from-env");
    } finally {
      delete process.env.DATABRICKS_CONFIG_PROFILE;
    }
  });

  it("mines the profile the SDK used when none was passed, so the login hint targets it", async () => {
    process.env.DATABRICKS_HOST = "https://foo.cloud.databricks.com";
    delete process.env.DATABRICKS_CONFIG_PROFILE;
    mockGetServiceClient.mockRejectedValue(
      new Error(
        "default auth: databricks-cli: cannot get access token: the refresh token is invalid. To reauthenticate, run\n  $ databricks auth login --profile DEFAULT",
      ),
    );

    const { result } = await checkAuth({});
    expect(result.hint).toContain("databricks auth login --profile DEFAULT");
    // Not the bare command, which would reauth the wrong profile.
    expect(result.hint).not.toContain("`databricks auth login`");
  });

  it("hints that the workspace is unreachable on a network error", async () => {
    process.env.DATABRICKS_HOST = "https://wrong.cloud.databricks.com";
    mockGetServiceClient.mockRejectedValue(
      new Error("getaddrinfo ENOTFOUND wrong.cloud.databricks.com"),
    );

    const { result } = await checkAuth({});
    expect(result.hint).toMatch(/host is correct and reachable/i);
    expect(result.hint).toMatch(/DATABRICKS_HOST/);
  });

  it("hints to log in and confirm the target when creds fail with nothing set", async () => {
    delete process.env.DATABRICKS_HOST;
    delete process.env.DATABRICKS_CONFIG_PROFILE;
    mockGetServiceClient.mockRejectedValue(
      new Error("default auth: cannot configure default credentials"),
    );

    const { result } = await checkAuth({});
    expect(result.hint).toContain("databricks auth login");
    expect(result.hint).toMatch(
      /confirm the profile\/host is the one you intend/i,
    );
  });

  it("reports the host the SDK resolved, not just DATABRICKS_HOST", async () => {
    // The headline mixed-source case: env wins the host, the profile supplies
    // the credentials, so the env var alone doesn't say what was contacted.
    delete process.env.DATABRICKS_HOST;
    mockGetServiceClient.mockResolvedValue({
      client: {
        config: { host: "https://from-profile.cloud.databricks.com" },
        currentUser: { me: async () => ({ userName: "u" }) },
      },
    });

    const { result } = await checkAuth({ profile: "prod" });
    expect(result.host).toBe("https://from-profile.cloud.databricks.com");
  });

  it("reads the resolved host only after me(), which is when the SDK resolves", async () => {
    // The SDK populates config.host lazily on the first API call, so reading it
    // at construction time would always yield undefined.
    delete process.env.DATABRICKS_HOST;
    const client: {
      config: { host?: string };
      currentUser: { me: () => Promise<{ userName: string }> };
    } = {
      config: {},
      currentUser: {
        me: async () => {
          client.config.host = "https://resolved-late.cloud.databricks.com";
          return { userName: "u" };
        },
      },
    };
    mockGetServiceClient.mockResolvedValue({ client });

    const { result } = await checkAuth({ profile: "prod" });
    expect(result.host).toBe("https://resolved-late.cloud.databricks.com");
  });

  it("keeps the resolved host on a failure after the client was built", async () => {
    delete process.env.DATABRICKS_HOST;
    mockGetServiceClient.mockResolvedValue({
      client: {
        config: { host: "https://from-profile.cloud.databricks.com" },
        currentUser: {
          me: async () => {
            throw new Error("boom");
          },
        },
      },
    });

    const { result } = await checkAuth({ profile: "prod" });
    expect(result.status).toBe("error");
    expect(result.host).toBe("https://from-profile.cloud.databricks.com");
  });

  it("recovers the host from the SDK error when no client was built", async () => {
    delete process.env.DATABRICKS_HOST;
    mockGetServiceClient.mockRejectedValue(
      new Error(
        "default auth: cannot configure default credentials. Config: host=https://dbc-abc123.cloud.databricks.com, profile=DEFAULT",
      ),
    );

    const { result } = await checkAuth({});
    expect(result.host).toBe("https://dbc-abc123.cloud.databricks.com");
  });

  it("strips prose punctuation off a host recovered from an error", async () => {
    delete process.env.DATABRICKS_HOST;
    mockGetServiceClient.mockRejectedValue(
      new Error(
        "cannot configure default credentials. host=https://foo.cloud.databricks.com.",
      ),
    );

    const { result } = await checkAuth({});
    expect(result.host).toBe("https://foo.cloud.databricks.com");
  });

  it("never leaks credentials embedded in a resolved host", async () => {
    delete process.env.DATABRICKS_HOST;
    mockGetServiceClient.mockResolvedValue({
      client: {
        config: { host: "https://user:secret@foo.cloud.databricks.com" },
        currentUser: { me: async () => ({ userName: "u" }) },
      },
    });

    const { result } = await checkAuth({});
    expect(result.host).not.toContain("secret");
    expect(result.host).toContain("foo.cloud.databricks.com");
  });

  it("warns when DATABRICKS_HOST and the profile target different workspaces", async () => {
    // Credentials work, but env won the host while the profile supplied the
    // token — a silent split that a green tick would hide.
    process.env.DATABRICKS_HOST = "https://env-ws.cloud.databricks.com";
    mockGetProfileHost.mockResolvedValue(
      "https://profile-ws.cloud.databricks.com",
    );
    mockGetServiceClient.mockResolvedValue({
      client: { currentUser: { me: async () => ({ userName: "u" }) } },
    });

    const { result, client } = await checkAuth({ profile: "prod" });
    expect(result.status).toBe("warn");
    expect(result.code).toBe("HOST_PROFILE_CONFLICT");
    expect(result.hint).toContain("env-ws.cloud.databricks.com");
    expect(result.hint).toContain("profile-ws.cloud.databricks.com");
    // Auth did succeed, so the live layers still get their client.
    expect(client).toBeDefined();
  });

  it("stays ok when the env host and profile host agree", async () => {
    process.env.DATABRICKS_HOST = "https://same.cloud.databricks.com";
    mockGetProfileHost.mockResolvedValue("https://same.cloud.databricks.com");
    mockGetServiceClient.mockResolvedValue({
      client: { currentUser: { me: async () => ({ userName: "u" }) } },
    });

    const { result } = await checkAuth({ profile: "prod" });
    expect(result.status).toBe("ok");
    expect(result.code).toBe("AUTH_OK");
  });

  it("treats hosts differing only by scheme, slash, or case as the same", async () => {
    process.env.DATABRICKS_HOST = "https://Same.Cloud.Databricks.com/";
    mockGetProfileHost.mockResolvedValue("same.cloud.databricks.com");
    mockGetServiceClient.mockResolvedValue({
      client: { currentUser: { me: async () => ({ userName: "u" }) } },
    });

    const { result } = await checkAuth({ profile: "prod" });
    expect(result.status).toBe("ok");
  });

  it("doesn't guess at a conflict when no profile is named", async () => {
    process.env.DATABRICKS_HOST = "https://env-ws.cloud.databricks.com";
    delete process.env.DATABRICKS_CONFIG_PROFILE;
    mockGetServiceClient.mockResolvedValue({
      client: { currentUser: { me: async () => ({ userName: "u" }) } },
    });

    const { result } = await checkAuth({});
    expect(result.status).toBe("ok");
    expect(mockGetProfileHost).not.toHaveBeenCalled();
  });

  it("prefers the conflict over a generic login hint when auth also failed", async () => {
    process.env.DATABRICKS_HOST = "https://env-ws.cloud.databricks.com";
    mockGetProfileHost.mockResolvedValue(
      "https://profile-ws.cloud.databricks.com",
    );
    mockGetServiceClient.mockRejectedValue(
      new Error("default auth: cannot configure default credentials"),
    );

    const { result } = await checkAuth({ profile: "prod" });
    expect(result.status).toBe("error");
    expect(result.hint).toMatch(/different workspaces/i);
    expect(result.hint).not.toMatch(/^Run `databricks auth login`/);
  });

  it("keeps detail short and carries the full message in raw for --detail/--json", async () => {
    process.env.DATABRICKS_HOST = "https://foo.cloud.databricks.com";
    const sprawling = `first line of the failure\n${"x".repeat(300)}`;
    mockGetServiceClient.mockRejectedValue(new Error(sprawling));

    const { result } = await checkAuth({});
    expect(result.detail).toBe("authentication failed");
    expect(result.raw).toBe(sprawling);
    expect(result.raw).toContain("first line of the failure");
    expect(result.raw).toContain("x".repeat(300));
  });
});
