import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkAuth, checkConfig, validateHost } from "./checks";
import type { ResourceTarget } from "./types";

const { mockGetServiceClient } = vi.hoisted(() => ({
  mockGetServiceClient: vi.fn(),
}));
vi.mock("./databricks-client", () => ({
  SdkNotInstalledError: class SdkNotInstalledError extends Error {},
  getServiceClient: mockGetServiceClient,
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

  beforeEach(() => {
    delete process.env.DOCTOR_TEST_ENV;
    delete process.env.DOCTOR_TEST_ENV_2;
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it("errors when a required resource's env var is unset", async () => {
    const result = await checkConfig(target());
    expect(result.status).toBe("error");
    expect(result.code).toBe("ENV_MISSING");
  });

  it("warns (not errors) when an optional resource's env var is unset", async () => {
    const result = await checkConfig(target({ required: false }));
    expect(result.status).toBe("warn");
    expect(result.code).toBe("ENV_MISSING_OPTIONAL");
  });

  it("passes an unfilled-looking value (existence check is the authority)", async () => {
    // Placeholder-looking values are NOT flagged here by design — the live
    // existence check decides whether a set value is real.
    process.env.DOCTOR_TEST_ENV = "your_sql_warehouse_id";
    const result = await checkConfig(target());
    expect(result.status).toBe("ok");
  });

  it("treats an empty string as missing", async () => {
    process.env.DOCTOR_TEST_ENV = "   ";
    const result = await checkConfig(target());
    expect(result.status).toBe("error");
    expect(result.code).toBe("ENV_MISSING");
  });

  it("passes when all env vars are set to real-looking values", async () => {
    process.env.DOCTOR_TEST_ENV = "abc123def456";
    const result = await checkConfig(target());
    expect(result.status).toBe("ok");
  });

  it("passes when a resource declares no env vars", async () => {
    const result = await checkConfig(target({ envVars: [] }));
    expect(result.status).toBe("ok");
  });

  it("reports all missing env vars when several are unset", async () => {
    const result = await checkConfig(
      target({ envVars: ["DOCTOR_TEST_ENV", "DOCTOR_TEST_ENV_2"] }),
    );
    expect(result.status).toBe("error");
    expect(result.detail).toContain("DOCTOR_TEST_ENV");
    expect(result.detail).toContain("DOCTOR_TEST_ENV_2");
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

describe("checkAuth", () => {
  const savedHost = process.env.DATABRICKS_HOST;

  afterEach(() => {
    mockGetServiceClient.mockReset();
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

  it("hints to reauthenticate on an expired/failed CLI token (real SDK message)", async () => {
    process.env.DATABRICKS_HOST = "https://foo.cloud.databricks.com";
    mockGetServiceClient.mockRejectedValue(
      new Error(
        "default auth: databricks-cli: cannot get access token: Command failed: databricks auth token",
      ),
    );

    const { result } = await checkAuth({ profile: "prod" });
    // Action-first: tells the user what to run and to confirm the target,
    // without redundantly repeating the profile name (it's in the command).
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

    // No --profile given, but the SDK fell back to DEFAULT — the hint must name it.
    const { result } = await checkAuth({});
    expect(result.hint).toContain("databricks auth login --profile DEFAULT");
    // Not the bare, profile-less command (which would reauth the wrong profile).
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
    // No profile/host known → generic login command + confirm-the-target note.
    expect(result.hint).toContain("databricks auth login");
    expect(result.hint).toMatch(
      /confirm the profile\/host is the one you intend/i,
    );
  });

  it("keeps detail short and carries the full message in raw for --detail/--json", async () => {
    process.env.DATABRICKS_HOST = "https://foo.cloud.databricks.com";
    const sprawling = `first line of the failure\n${"x".repeat(300)}`;
    mockGetServiceClient.mockRejectedValue(new Error(sprawling));

    const { result } = await checkAuth({});
    // Human report headline is always the short, constant string...
    expect(result.detail).toBe("authentication failed");
    // ...while the full multi-line error is preserved verbatim in raw.
    expect(result.raw).toBe(sprawling);
    expect(result.raw).toContain("first line of the failure");
    expect(result.raw).toContain("x".repeat(300));
  });
});
