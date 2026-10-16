import { afterEach, describe, expect, test } from "vitest";

import {
  assertAppkitBranch,
  BranchGuardError,
  checkAppkitBranch,
  classifyBranch,
} from "../guard";
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
  test("only this developer's dev branch and this checkout's session branch are AppKit-owned", () => {
    expect(verdict(dev)).toEqual({ appkitOwned: true });
    expect(verdict(`${P}/branches/session-k2x9q0ab`)).toEqual({
      appkitOwned: true,
    });
  });

  test("everything else is refused, with the reason", () => {
    expect(
      verdict(`${P}/branches/production`, { default: true }),
    ).toMatchObject({
      appkitOwned: false,
      reason: "it is the project's default branch",
    });
    expect(verdict(dev, { is_protected: true })).toMatchObject({
      appkitOwned: false,
      reason: "it is a protected branch",
    });
    expect(
      verdict(dev, {}, null, [`${P}/branches/staging`, dev]),
    ).toMatchObject({
      appkitOwned: false,
      reason: "it is a branch databricks.yml deploys to",
    });
    expect(
      verdict(`${P}/branches/${devBranchId("bob@example.com")}`).appkitOwned,
    ).toBe(false);
    expect(verdict(`${P}/branches/session-other`).appkitOwned).toBe(false);
    expect(
      verdict(`${P}/branches/session-k2x9q0ab`, {}, null).appkitOwned,
    ).toBe(false);
    expect(verdict(`${P}/branches/staging`).reason).toContain(
      devBranchId(USER),
    );
  });
});

describe("checkAppkitBranch", () => {
  const envFor = (branch: string) => ({
    LAKEBASE_ENDPOINT: `${branch}/endpoints/primary`,
  });

  test("classifies the .env branch through the API, without connecting", async () => {
    const lakebase = new FakeLakebase();
    lakebase.addBranch(dev);
    lakebase.addBranch(`${P}/branches/production`, { default: true });

    const onDev = await checkAppkitBranch(
      fakeContext({ root: tempApp(), env: envFor(dev), api: lakebase.api() }),
    );
    expect(onDev).toMatchObject({
      branch: { name: dev },
      verdict: { appkitOwned: true },
    });

    const onDefault = await checkAppkitBranch(
      fakeContext({
        root: tempApp(),
        env: envFor(`${P}/branches/production`),
        api: lakebase.api(),
      }),
    );
    expect(onDefault?.verdict).toEqual({
      appkitOwned: false,
      reason: "it is the project's default branch",
    });
    expect(lakebase.calls.every((call) => call.startsWith("getBranch"))).toBe(
      true,
    );
  });

  test("a branch databricks.yml deploys to is never AppKit-owned", async () => {
    const lakebase = new FakeLakebase();
    lakebase.addBranch(dev);
    const root = tempApp({
      "databricks.yml": databricksYml(
        dev,
        `${dev}/databases/databricks-postgres`,
      ),
    });

    const check = await checkAppkitBranch(
      fakeContext({ root, env: envFor(dev), api: lakebase.api() }),
    );

    expect(check?.verdict).toEqual({
      appkitOwned: false,
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

    const check = await checkAppkitBranch(
      fakeContext({
        root: personalTarget,
        env: envFor(dev),
        api: lakebase.api(),
      }),
    );
    expect(check?.verdict).toEqual({
      appkitOwned: false,
      reason: "it is a branch databricks.yml deploys to",
    });
    await expect(
      checkAppkitBranch(
        fakeContext({ root: broken, env: envFor(dev), api: lakebase.api() }),
      ),
    ).rejects.toThrow(
      /^Cannot read databricks\.yml, so the branches it deploys to are unknown: /,
    );
  });

  test("null without a configured branch; a deleted branch points at init", async () => {
    const lakebase = new FakeLakebase();
    await expect(
      checkAppkitBranch(fakeContext({ root: tempApp(), api: lakebase.api() })),
    ).resolves.toBeNull();
    await expect(
      checkAppkitBranch(
        fakeContext({ root: tempApp(), env: envFor(dev), api: lakebase.api() }),
      ),
    ).rejects.toThrow(/does not exist.*appkit db init/);
  });
});

describe("assertAppkitBranch", () => {
  const envFor = (branch: string) => ({
    LAKEBASE_ENDPOINT: `${branch}/endpoints/primary`,
  });

  test("passes the .env branch when it is the developer's dev branch", async () => {
    const lakebase = new FakeLakebase();
    lakebase.addBranch(dev);
    const ctx = fakeContext({
      root: tempApp(),
      env: envFor(dev),
      api: lakebase.api(),
    });

    await expect(assertAppkitBranch(ctx, "clean")).resolves.toMatchObject({
      name: dev,
    });
  });

  test("refuses the default branch and the deploy branch, using only the API", async () => {
    const lakebase = new FakeLakebase();
    lakebase.addBranch(`${P}/branches/production`, { default: true });
    lakebase.addBranch(dev);

    const onDefault = fakeContext({
      root: tempApp(),
      env: envFor(`${P}/branches/production`),
      api: lakebase.api(),
    });
    const error = await assertAppkitBranch(onDefault, "clean").catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(BranchGuardError);
    expect((error as Error).message).toBe(
      "Refusing to clean production: it is the project's default branch. `appkit db clean` only writes to branches `appkit db init` created for you (dev-… or session-…).",
    );

    const deployRoot = tempApp({
      "databricks.yml": databricksYml(
        dev,
        `${dev}/databases/databricks-postgres`,
      ),
    });
    const onDeploy = fakeContext({
      root: deployRoot,
      env: envFor(dev),
      api: lakebase.api(),
    });
    await expect(assertAppkitBranch(onDeploy, "seed")).rejects.toThrow(
      /deploys to/,
    );
    expect(lakebase.calls.every((call) => call.startsWith("getBranch"))).toBe(
      true,
    );
  });

  test("without a configured branch it refuses, and a deleted branch points at init", async () => {
    const lakebase = new FakeLakebase();
    await expect(
      assertAppkitBranch(
        fakeContext({ root: tempApp(), api: lakebase.api() }),
        "seed",
      ),
    ).rejects.toThrow(/no branch configured/);
    await expect(
      checkAppkitBranch(
        fakeContext({ root: tempApp(), env: envFor(dev), api: lakebase.api() }),
      ),
    ).rejects.toThrow(/does not exist.*appkit db init/);
  });
});
