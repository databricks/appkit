import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../../workspace-client", () => ({
  createWorkspaceClient: vi.fn(() => ({})),
}));

const { createWorkspaceClient } = await import("../../workspace-client");
const { createTypegenWorkspaceClient } = await import("../typegen-client");

describe("createTypegenWorkspaceClient", () => {
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

  test("falls back to the default client when unset or empty", () => {
    vi.stubEnv("APPKIT_DEV_PROFILE", "");
    createTypegenWorkspaceClient();
    expect(createWorkspaceClient).toHaveBeenCalledWith();
  });
});
