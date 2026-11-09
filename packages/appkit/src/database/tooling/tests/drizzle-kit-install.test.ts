import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { drizzleKitInstall, ensureDrizzleKit } from "../drizzle-kit-install";
import { DRIZZLE_KIT_VERSION } from "../migrations";
import { cleanupTempApps, tempApp } from "./fakes";

afterEach(() => {
  cleanupTempApps();
  vi.unstubAllEnvs();
});

const SPEC = `drizzle-kit@${DRIZZLE_KIT_VERSION}`;

describe("drizzleKitInstall", () => {
  test.each([
    ["pnpm-lock.yaml", "pnpm", ["add", "-D", "-E", SPEC]],
    ["yarn.lock", "yarn", ["add", "-D", "-E", SPEC]],
    ["bun.lock", "bun", ["add", "-d", "--exact", SPEC]],
    [
      "package-lock.json",
      "npm",
      ["install", "--save-dev", "--save-exact", SPEC],
    ],
  ])("%s installs with %s, pinned", (lockfile, command, args) => {
    expect(drizzleKitInstall(tempApp({ [lockfile]: "" }))).toEqual({
      command,
      args,
    });
  });

  test("a workspace member uses the lockfile of the workspace root", () => {
    const root = tempApp({
      "pnpm-lock.yaml": "",
      "apps/web/package.json": "{}",
    });
    expect(drizzleKitInstall(path.join(root, "apps/web")).command).toBe("pnpm");
  });

  test("the packageManager field wins over a conflicting lockfile, in the app and in its workspace root", () => {
    const declared = tempApp({
      "package.json": JSON.stringify({ packageManager: "yarn@4.0.0" }),
      "package-lock.json": "{}",
    });
    expect(drizzleKitInstall(declared).command).toBe("yarn");

    const workspace = tempApp({
      "package.json": JSON.stringify({ packageManager: "bun@1.1.0" }),
      "package-lock.json": "{}",
      "apps/web/package.json": "{}",
    });
    expect(drizzleKitInstall(path.join(workspace, "apps/web")).command).toBe(
      "bun",
    );
  });

  test("without a field or lockfile anywhere, the launcher's manager is used, else npm", () => {
    const root = tempApp({ "package.json": "{}" });
    vi.stubEnv("npm_config_user_agent", "yarn/4.0.0 npm/? node/v22");
    expect(drizzleKitInstall(root).command).toBe("yarn");

    vi.stubEnv("npm_config_user_agent", undefined);
    expect(drizzleKitInstall(root)).toEqual({
      command: "npm",
      args: ["install", "--save-dev", "--save-exact", SPEC],
    });
  });
});

describe("ensureDrizzleKit", () => {
  test("installs into the app when it cannot resolve drizzle-kit, and reports the command", () => {
    const root = tempApp({ "package.json": "{}", "yarn.lock": "" });
    const run = vi.fn();
    const steps: string[] = [];

    expect(ensureDrizzleKit(root, run, (step) => steps.push(step))).toBe(
      `yarn add -D -E ${SPEC}`,
    );
    expect(run).toHaveBeenCalledWith("yarn", ["add", "-D", "-E", SPEC], root);
    expect(steps).toEqual([
      `Installing drizzle-kit ${DRIZZLE_KIT_VERSION}, which writes migrations (yarn add -D -E ${SPEC})`,
    ]);
  });

  test("does nothing when drizzle-kit resolves, or there is no package.json", () => {
    const run = vi.fn();
    const installed = tempApp({
      "package.json": "{}",
      "node_modules/drizzle-kit/package.json": JSON.stringify({
        name: "drizzle-kit",
        version: "0.30.0",
        main: "index.js",
      }),
      "node_modules/drizzle-kit/index.js": "",
    });

    expect(ensureDrizzleKit(installed, run, () => undefined)).toBeNull();
    expect(ensureDrizzleKit(tempApp(), run, () => undefined)).toBeNull();
    expect(run).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(installed, "package-lock.json"))).toBe(
      false,
    );
  });
});
