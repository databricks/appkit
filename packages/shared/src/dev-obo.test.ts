import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createDevOboIdentityProvider,
  loadDevOboIdentity,
  loadDevOboIdentityFromEnvironment,
} from "./dev-obo";

afterEach(() => vi.restoreAllMocks());

describe("local OBO identity", () => {
  test("prefers DATABRICKS_TOKEN and resolves its user without a profile", async () => {
    const run = vi.fn(async (_args: string[], _env?: NodeJS.ProcessEnv) => ({
      stdout: JSON.stringify({
        id: "alice",
        userName: "alice@example.com",
      }),
    }));

    await expect(
      loadDevOboIdentityFromEnvironment(
        {
          DATABRICKS_HOST: "https://workspace.example",
          DATABRICKS_TOKEN: "fake-direct-token",
          DATABRICKS_CONFIG_PROFILE: "ignored-profile",
        },
        run,
      ),
    ).resolves.toEqual({
      token: "fake-direct-token",
      userId: "alice",
      email: "alice@example.com",
    });
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0]).toEqual([
      "current-user",
      "me",
      "--host",
      "https://workspace.example",
      "--output",
      "json",
    ]);
    expect(run.mock.calls[0]?.[1]).toMatchObject({
      DATABRICKS_HOST: "https://workspace.example",
      DATABRICKS_TOKEN: "fake-direct-token",
    });
    expect(run.mock.calls[0]?.[1]).not.toHaveProperty(
      "DATABRICKS_CONFIG_PROFILE",
    );
  });

  test("falls back to the explicitly configured profile without a token", async () => {
    const run = vi.fn(async (args: string[]) => ({
      stdout: JSON.stringify(
        args[0] === "auth"
          ? { access_token: "fake-profile-token" }
          : { id: "alice" },
      ),
    }));

    await expect(
      loadDevOboIdentityFromEnvironment(
        { DATABRICKS_CONFIG_PROFILE: "selected-user" },
        run,
      ),
    ).resolves.toEqual({ token: "fake-profile-token", userId: "alice" });
    expect(run).toHaveBeenCalledWith([
      "auth",
      "token",
      "--profile",
      "selected-user",
    ]);
  });

  test("does not fall back to a profile when a token has no host", async () => {
    const run = vi.fn();
    await expect(
      loadDevOboIdentityFromEnvironment(
        {
          DATABRICKS_TOKEN: "fake-direct-token",
          DATABRICKS_CONFIG_PROFILE: "must-not-be-used",
        },
        run,
      ),
    ).rejects.toThrow("Set DATABRICKS_HOST");
    expect(run).not.toHaveBeenCalled();
  });

  test("never falls back to an implicit CLI profile", async () => {
    const run = vi.fn();
    await expect(loadDevOboIdentity(" ", run)).rejects.toThrow(
      "explicitly selected Databricks user profile",
    );
    expect(run).not.toHaveBeenCalled();
  });

  test.each([
    { id: "sp", applicationId: "application-id" },
    {
      id: "sp",
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServicePrincipal"],
    },
  ])("rejects a service principal profile: %j", async (user) => {
    const run = vi.fn(async (args: string[]) => ({
      stdout: JSON.stringify(
        args[0] === "auth" ? { access_token: "fake-token" } : user,
      ),
    }));
    await expect(loadDevOboIdentity("selected-sp", run)).rejects.toThrow(
      "user profile",
    );
  });

  test("shares concurrent initial loads and refreshes without using stale credentials", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const first = { token: "fake-token-1", userId: "alice" };
    const second = { token: "fake-token-2", userId: "alice" };
    const load = vi.fn().mockResolvedValue(first);
    const getIdentity = createDevOboIdentityProvider(load);
    expect(await Promise.all([getIdentity(), getIdentity()])).toEqual([
      first,
      first,
    ]);
    expect(load).toHaveBeenCalledTimes(1);

    now += 29_999;
    expect(await getIdentity()).toEqual(first);
    expect(load).toHaveBeenCalledTimes(1);
    now += 1;
    load.mockResolvedValue(second);
    expect(await Promise.all([getIdentity(), getIdentity()])).toEqual([
      second,
      second,
    ]);
    expect(load).toHaveBeenCalledTimes(2);

    now += 30_000;
    load.mockRejectedValue(new Error("expired"));
    await expect(getIdentity()).rejects.toThrow("expired");
    await expect(getIdentity()).rejects.toThrow("expired");
    load.mockResolvedValue(second);
    expect(await getIdentity()).toEqual(second);
  });
});
