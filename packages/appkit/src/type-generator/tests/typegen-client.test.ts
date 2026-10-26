import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("../../workspace-client", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../workspace-client")>();
  return { ...actual, createWorkspaceClient: vi.fn(() => ({})) };
});

const { createWorkspaceClient } = await import("../../workspace-client");
const { createTypegenWorkspaceClient } = await import("../typegen-client");

const DEV_HOST = "http://127.0.0.1:8004";
const DEV_TOKEN = "dev-placeholder-token";

describe("createTypegenWorkspaceClient", () => {
  beforeEach(() => {
    // Start from a clean slate regardless of the developer's shell env.
    vi.stubEnv("APPKIT_DEV_PROFILE", "");
    vi.stubEnv("APPKIT_DEV_HOST", "");
    vi.stubEnv("APPKIT_DEV_TOKEN", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(createWorkspaceClient).mockClear();
  });

  test("uses APPKIT_DEV_PROFILE when set", () => {
    vi.stubEnv("APPKIT_DEV_PROFILE", "my-profile");
    createTypegenWorkspaceClient();
    expect(createWorkspaceClient).toHaveBeenCalledWith({
      profile: "my-profile",
    });
  });

  test("APPKIT_DEV_PROFILE takes precedence over APPKIT_DEV_HOST / APPKIT_DEV_TOKEN", () => {
    vi.stubEnv("APPKIT_DEV_PROFILE", "my-profile");
    vi.stubEnv("APPKIT_DEV_HOST", DEV_HOST);
    vi.stubEnv("APPKIT_DEV_TOKEN", DEV_TOKEN);
    createTypegenWorkspaceClient();
    expect(createWorkspaceClient).toHaveBeenCalledWith({
      profile: "my-profile",
    });
  });

  test("uses APPKIT_DEV_HOST + APPKIT_DEV_TOKEN when both are set", () => {
    vi.stubEnv("APPKIT_DEV_HOST", DEV_HOST);
    vi.stubEnv("APPKIT_DEV_TOKEN", DEV_TOKEN);
    createTypegenWorkspaceClient();
    expect(createWorkspaceClient).toHaveBeenCalledWith({
      host: DEV_HOST,
      token: DEV_TOKEN,
    });
  });

  test.each([
    ["host only", { APPKIT_DEV_HOST: DEV_HOST }],
    ["token only", { APPKIT_DEV_TOKEN: DEV_TOKEN }],
    ["host empty", { APPKIT_DEV_HOST: "", APPKIT_DEV_TOKEN: DEV_TOKEN }],
    ["token empty", { APPKIT_DEV_HOST: DEV_HOST, APPKIT_DEV_TOKEN: "" }],
    ["nothing set", {}],
  ])("falls back to the default client (%s)", (_label, env) => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    createTypegenWorkspaceClient();
    expect(createWorkspaceClient).toHaveBeenCalledWith();
  });
});

describe("createTypegenWorkspaceClient with the real factory", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("dev host/token build a PAT client even when SP credentials are in env", async () => {
    vi.stubEnv("APPKIT_DEV_PROFILE", "");
    vi.stubEnv("APPKIT_DEV_HOST", DEV_HOST);
    vi.stubEnv("APPKIT_DEV_TOKEN", DEV_TOKEN);
    vi.stubEnv("DATABRICKS_HOST", "https://sp.cloud.databricks.com");
    vi.stubEnv("DATABRICKS_CLIENT_ID", "sp-client-id");
    vi.stubEnv("DATABRICKS_CLIENT_SECRET", "sp-client-secret");

    const actual = await vi.importActual<
      typeof import("../../workspace-client")
    >("../../workspace-client");
    vi.mocked(createWorkspaceClient).mockImplementationOnce(
      actual.createWorkspaceClient,
    );

    // The dev token is what gets sent, not the SP env credentials.
    const client = createTypegenWorkspaceClient();
    const headers = new Headers();
    await client.authenticate(headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${DEV_TOKEN}`);
    expect(await client.getHost()).toBe(DEV_HOST);
  });
});
