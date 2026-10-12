import { afterEach, describe, expect, test, vi } from "vitest";

import { currentIdentity } from "../identity";
import { cleanupTempApps, fakeContext, tempApp } from "./fakes";

afterEach(cleanupTempApps);

describe("identity", () => {
  test("currentUser.me() is called once per context", async () => {
    const ctx = fakeContext({ root: tempApp() });
    const me = vi.fn(async () => ({ userName: "alice@example.com" }));
    const client = { ...ctx.workspace(), currentUser: { me } };
    const counted = { ...ctx, workspace: () => client };

    await expect(currentIdentity(counted)).resolves.toEqual({
      userName: "alice@example.com",
    });
    await currentIdentity(counted);
    expect(me).toHaveBeenCalledOnce();
  });

  test("no userName is an error that points at the profile", async () => {
    const ctx = fakeContext({ root: tempApp() });
    const client = {
      ...ctx.workspace(),
      currentUser: { me: async () => ({}) },
    };
    await expect(
      currentIdentity({ ...ctx, workspace: () => client }),
    ).rejects.toThrow(/DATABRICKS_CONFIG_PROFILE/);
  });
});
