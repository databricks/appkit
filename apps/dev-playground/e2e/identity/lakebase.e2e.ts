import { expect, test } from "e2e";

import {
  DISTINCT_SP,
  NEEDS_DISTINCT_SP,
  SP_CLIENT_ID,
  userHeaders,
} from "./env";

test.describe("lakebase is app-only", () => {
  test("B7: a Lakebase query connects as the SP even with user headers", async ({
    app,
  }) => {
    test.skip(!DISTINCT_SP, NEEDS_DISTINCT_SP);
    const res = await fetch(new URL("/e2e/lakebase", app.baseUrl), {
      headers: userHeaders,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ identity: SP_CLIENT_ID });
  });

  test("B7: asUser(req).lakebase is refused, never run as the user", async ({
    app,
  }) => {
    const res = await fetch(new URL("/e2e/lakebase-as-user", app.baseUrl), {
      headers: userHeaders,
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: "APP_ONLY_RESOURCE" });
  });
});
