import { readFile } from "node:fs/promises";

import { expect, test } from "e2e";

import { postSse, userHeaders } from "./env";

const LOG = new URL("../../.e2e/logs/identity-app.log", import.meta.url);

test("core plugins on the OBO path log no Plugin.asUser deprecation warning", async ({
  app,
}) => {
  await postSse(
    new URL("/api/analytics/query/whoami_obo", app.baseUrl),
    { parameters: {} },
    userHeaders,
  );
  await fetch(new URL("/e2e/as-user-oneshot", app.baseUrl), {
    headers: userHeaders,
  });

  const log = await readFile(LOG, "utf8");
  const thisRun = log.slice(log.lastIndexOf("e2e-identity-app: boot"));
  expect(thisRun).toContain("e2e-identity-app: boot");
  expect(thisRun).not.toContain("Plugin.asUser is deprecated");
});
