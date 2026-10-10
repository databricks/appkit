import { expect, test } from "e2e";

import {
  DISTINCT_SP,
  NEEDS_DISTINCT_SP,
  SP_CLIENT_ID,
  USER_EMAIL,
  userHeaders,
} from "./env";

async function probe(
  baseUrl: string | undefined,
  path: string,
  headers: Record<string, string> = {},
) {
  const res = await fetch(new URL(path, baseUrl), { headers });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

test.describe("appkit.asUser(req)", () => {
  test("B3: asUser(req).run(...) runs as the user", async ({ app }) => {
    test.skip(!DISTINCT_SP, NEEDS_DISTINCT_SP);
    expect(await probe(app.baseUrl, "/e2e/as-user-block", userHeaders)).toEqual(
      {
        status: 200,
        body: { identity: USER_EMAIL },
      },
    );
  });

  test("B3: the one-call asUser(req).plugin.method() form runs as the user", async ({
    app,
  }) => {
    test.skip(!DISTINCT_SP, NEEDS_DISTINCT_SP);
    expect(
      await probe(app.baseUrl, "/e2e/as-user-oneshot", userHeaders),
    ).toEqual({
      status: 200,
      body: { identity: USER_EMAIL },
    });
  });

  test("B4: a plain plugin call runs as the SP even with user headers", async ({
    app,
  }) => {
    test.skip(!DISTINCT_SP, NEEDS_DISTINCT_SP);
    expect(await probe(app.baseUrl, "/e2e/default", userHeaders)).toEqual({
      status: 200,
      body: { identity: SP_CLIENT_ID },
    });
  });

  test("fail-closed: asUser with no user token rejects instead of running as the SP", async ({
    app,
  }) => {
    for (const path of ["/e2e/as-user-block", "/e2e/as-user-oneshot"]) {
      const { status, body } = await probe(app.baseUrl, path);
      expect(status).toBe(500);
      expect(body.code).toBe("AUTHENTICATION_ERROR");
      expect(body.identity).toBeUndefined();
    }
  });
});
