import { expect, test } from "e2e";

import {
  DISTINCT_SP,
  identityFromQuery,
  NEEDS_DISTINCT_SP,
  postSse,
  SP_CLIENT_ID,
  USER_EMAIL,
  userHeaders,
} from "./env";

test.describe("analytics query files", () => {
  test("B1: a .sql query runs as the app service principal", async ({
    app,
  }) => {
    test.skip(!DISTINCT_SP, NEEDS_DISTINCT_SP);
    const { status, events } = await postSse(
      new URL("/api/analytics/query/whoami", app.baseUrl),
      { parameters: {} },
      userHeaders,
    );
    expect(status).toBe(200);
    expect(identityFromQuery(events)).toBe(SP_CLIENT_ID);
  });

  test("B2: a .obo.sql query runs as the signed-in user", async ({ app }) => {
    test.skip(!DISTINCT_SP, NEEDS_DISTINCT_SP);
    const { status, events } = await postSse(
      new URL("/api/analytics/query/whoami_obo", app.baseUrl),
      { parameters: {} },
      userHeaders,
    );
    expect(status).toBe(200);
    expect(identityFromQuery(events)).toBe(USER_EMAIL);
  });
});
