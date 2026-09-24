import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addCommand } from "./add";
import { fetchRegistryItem, fetchVerifiedNames } from "./client";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: vi.fn(),
}));

vi.mock("./client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client")>()),
  fetchRegistryItem: vi.fn(),
  fetchVerifiedNames: vi.fn(),
}));

vi.mock("./constants", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./constants")>()),
  resolveToken: () => null,
}));

describe("registry add package manager", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "registry-pm-"));
    fs.writeFileSync(
      path.join(cwd, "package.json"),
      JSON.stringify({ name: "test-app" }),
    );
    vi.stubEnv("npm_config_user_agent", undefined);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(fetchRegistryItem).mockResolvedValue({
      name: "pm-fixture",
      dependencies: ["kleur@4.1.5"],
      files: [],
    });
    vi.mocked(fetchVerifiedNames).mockResolvedValue(new Set(["pm-fixture"]));
    vi.mocked(spawnSync).mockReturnValue({
      pid: 0,
      output: [],
      stdout: "",
      stderr: "",
      status: 0,
      signal: null,
    });
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it.each([
    ["pnpm-lock.yaml", "npm/11.8.0", "pnpm"],
    ["yarn.lock", "npm/11.8.0", "yarn"],
    ["package-lock.json", "pnpm/11.0.8", "npm"],
    ["npm-shrinkwrap.json", undefined, "npm"],
    ["bun.lock", undefined, "bun"],
    ["bun.lockb", undefined, "bun"],
    [null, undefined, "npm"],
  ] as const)(
    "installs with %s and launcher %s using %s",
    async (lockfile, userAgent, pm) => {
      if (lockfile) fs.writeFileSync(path.join(cwd, lockfile), "");
      vi.stubEnv("npm_config_user_agent", userAgent);

      await addCommand.parseAsync(["pm-fixture", "--cwd", cwd, "--yes"], {
        from: "user",
      });

      expect(spawnSync).toHaveBeenCalledExactlyOnceWith(
        pm,
        [pm === "npm" ? "install" : "add", "--", "kleur@4.1.5"],
        { cwd, stdio: "inherit" },
      );
    },
  );
});
