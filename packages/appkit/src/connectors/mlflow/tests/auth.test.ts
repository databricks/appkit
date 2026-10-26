import { describe, expect, test, vi } from "vitest";

const { createWorkspaceClient } = vi.hoisted(() => ({
  createWorkspaceClient: vi.fn(),
}));
vi.mock("../../../workspace-client", () => ({ createWorkspaceClient }));

import { resolveDatabricksAuth } from "../auth";

describe("resolveDatabricksAuth", () => {
  test("profile path: takes the bearer + host from the client's modular auth seam", async () => {
    createWorkspaceClient.mockReturnValue({
      authenticate: async (headers: Headers) => {
        headers.set("Authorization", "Bearer minted");
      },
      getHost: async () => "https://ws.cloud.databricks.com",
    });

    await expect(
      resolveDatabricksAuth({ profile: "dogfood" }),
    ).resolves.toEqual({
      host: "https://ws.cloud.databricks.com",
      token: "minted",
    });
    expect(createWorkspaceClient).toHaveBeenCalledWith({ profile: "dogfood" });
  });

  test("returns undefined when credentials can't be resolved", async () => {
    createWorkspaceClient.mockReturnValue({
      authenticate: async () => {
        throw new Error("no auth configured");
      },
      getHost: async () => "https://x",
    });

    await expect(resolveDatabricksAuth({})).resolves.toBeUndefined();
  });
});
