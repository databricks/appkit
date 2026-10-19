import { afterEach, describe, expect, test } from "vitest";

import { classifyBranch, resolveEnvBranch, takesWrites } from "../guard";
import { devBranchId } from "../naming";
import {
  cleanupTempApps,
  databricksYml,
  FakeLakebase,
  fakeContext,
  tempApp,
} from "./fakes";

afterEach(cleanupTempApps);

const USER = "alice@example.com";
const P = "projects/p";
const dev = `${P}/branches/${devBranchId(USER)}`;

function verdict(
  name: string,
  status = {},
  sessionId: string | null = "k2x9q0ab",
  deployBranches: string[] = [],
) {
  return classifyBranch({
    branch: { name, status },
    userName: USER,
    sessionId,
    deployBranches,
  });
}

describe("classifyBranch", () => {
  test("only this developer's dev branch and this checkout's session branch take writes", () => {
    expect(verdict(dev)).toEqual({ kind: "dev" });
    expect(verdict(`${P}/branches/session-k2x9q0ab`)).toEqual({
      kind: "session",
    });
    expect(takesWrites("dev")).toBe(true);
    expect(takesWrites("session")).toBe(true);
  });

  test("everything else is another kind, with the reason", () => {
    expect(verdict(`${P}/branches/production`, { default: true })).toEqual({
      kind: "default",
      reason: "it is the project's default branch",
    });
    expect(verdict(dev, { is_protected: true })).toEqual({
      kind: "protected",
      reason: "it is a protected branch",
    });
    expect(verdict(dev, {}, null, [`${P}/branches/staging`, dev])).toEqual({
      kind: "deploy-target",
      reason: "it is a branch databricks.yml deploys to",
    });
    expect(
      verdict(`${P}/branches/${devBranchId("bob@example.com")}`).kind,
    ).toBe("other");
    expect(verdict(`${P}/branches/session-other`).kind).toBe("other");
    expect(verdict(`${P}/branches/session-k2x9q0ab`, {}, null).kind).toBe(
      "other",
    );
    expect(verdict(`${P}/branches/staging`).reason).toContain(
      devBranchId(USER),
    );
    for (const kind of ["default", "protected", "deploy-target", "other"]) {
      expect(takesWrites(kind as "other")).toBe(false);
    }
  });
});

describe("resolveEnvBranch", () => {
  const envFor = (branch: string) => ({
    PGHOST: "primary.example.com",
    PGDATABASE: "databricks_postgres",
    LAKEBASE_ENDPOINT: `${branch}/endpoints/primary`,
  });

  test("classifies the .env branch through the API, without connecting", async () => {
    const lakebase = new FakeLakebase();
    lakebase.addBranch(dev);
    lakebase.addBranch(`${P}/branches/production`, { default: true });

    const onDev = await resolveEnvBranch(
      fakeContext({ root: tempApp(), env: envFor(dev), api: lakebase.api() }),
    );
    expect(onDev).toMatchObject({ branch: { name: dev }, kind: "dev" });
    expect(onDev?.reason).toBeUndefined();

    const onDefault = await resolveEnvBranch(
      fakeContext({
        root: tempApp(),
        env: envFor(`${P}/branches/production`),
        api: lakebase.api(),
      }),
    );
    expect(onDefault).toMatchObject({
      kind: "default",
      reason: "it is the project's default branch",
    });
    expect(lakebase.calls.every((call) => call.startsWith("getBranch"))).toBe(
      true,
    );
  });

  test("a branch databricks.yml deploys to never takes writes", async () => {
    const lakebase = new FakeLakebase();
    lakebase.addBranch(dev);
    const root = tempApp({
      "databricks.yml": databricksYml(
        dev,
        `${dev}/databases/databricks-postgres`,
      ),
    });

    const env = await resolveEnvBranch(
      fakeContext({ root, env: envFor(dev), api: lakebase.api() }),
    );

    expect(env).toMatchObject({
      kind: "deploy-target",
      reason: "it is a branch databricks.yml deploys to",
    });
  });

  test("a non-default target counts too, and an unreadable databricks.yml refuses", async () => {
    const lakebase = new FakeLakebase();
    lakebase.addBranch(dev);
    const personalTarget = tempApp({
      "databricks.yml": `${databricksYml(`${P}/branches/production`, `${P}/branches/production/databases/db`)}  personal:
    variables:
      postgres_branch: ${dev}
`,
    });
    const broken = tempApp({ "databricks.yml": "targets:\n  default: [\n" });

    const env = await resolveEnvBranch(
      fakeContext({
        root: personalTarget,
        env: envFor(dev),
        api: lakebase.api(),
      }),
    );
    expect(env).toMatchObject({ kind: "deploy-target" });
    await expect(
      resolveEnvBranch(
        fakeContext({ root: broken, env: envFor(dev), api: lakebase.api() }),
      ),
    ).rejects.toThrow(
      /^Cannot read databricks\.yml, so the branches it deploys to are unknown: /,
    );
  });

  test("null unless .env names a branch to connect to; a deleted branch points at init", async () => {
    const lakebase = new FakeLakebase();
    await expect(
      resolveEnvBranch(fakeContext({ root: tempApp(), api: lakebase.api() })),
    ).resolves.toBeNull();
    const { PGHOST: _host, ...noHost } = envFor(dev);
    await expect(
      resolveEnvBranch(
        fakeContext({ root: tempApp(), env: noHost, api: lakebase.api() }),
      ),
    ).resolves.toBeNull();
    expect(lakebase.calls).toEqual([]);
    await expect(
      resolveEnvBranch(
        fakeContext({ root: tempApp(), env: envFor(dev), api: lakebase.api() }),
      ),
    ).rejects.toThrow(/does not exist.*appkit db init/);
  });
});
