import { afterEach, describe, expect, test, vi } from "vitest";

import { currentIdentity, identityTypeOf } from "../identity";
import { cleanupTempApps, fakeContext, tempApp } from "./fakes";

afterEach(cleanupTempApps);

describe("identity", () => {
  test("an email is a USER, a client ID is a SERVICE_PRINCIPAL", () => {
    expect(identityTypeOf("alice@example.com")).toBe("USER");
    expect(identityTypeOf("11111111-2222-3333-4444-555555555555")).toBe(
      "SERVICE_PRINCIPAL",
    );
  });

  test("currentUser.me() is called once per context", async () => {
    const ctx = fakeContext({ root: tempApp() });
    const me = vi.fn(async () => ({ userName: "alice@example.com" }));
    const client = { ...ctx.workspace(), currentUser: { me } };
    const counted = { ...ctx, workspace: () => client };

    await expect(currentIdentity(counted)).resolves.toEqual({
      userName: "alice@example.com",
      identityType: "USER",
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
