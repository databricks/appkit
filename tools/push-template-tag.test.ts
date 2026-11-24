import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { pushTemplateTag } from "./push-template-tag";

let directory: string;

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function commitFile(
  cwd: string,
  file: string,
  content: string,
  message: string,
) {
  mkdirSync(join(cwd, "template"), { recursive: true });
  writeFileSync(join(cwd, file), content);
  git(cwd, "add", file);
  git(cwd, "commit", "-m", message);
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "appkit-template-tag-test-"));
  // No user config or hooks; a fixed identity.
  writeFileSync(join(directory, "gitconfig"), "");
  vi.stubEnv("GIT_CONFIG_GLOBAL", join(directory, "gitconfig"));
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  for (const role of ["AUTHOR", "COMMITTER"]) {
    vi.stubEnv(`GIT_${role}_NAME`, "Release Bot");
    vi.stubEnv(`GIT_${role}_EMAIL`, "release@example.com");
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

test("tags the released code even when the branch moved meanwhile", () => {
  const origin = join(directory, "origin.git");
  const runner = join(directory, "runner");
  const other = join(directory, "other");
  git(directory, "init", "-q", "--bare", "-b", "main", origin);
  git(directory, "clone", "-q", origin, runner);
  commitFile(runner, "template/app.ts", "released\n", "chore: release v2");
  git(runner, "push", "-q", "origin", "main");
  const released = git(runner, "rev-parse", "HEAD");

  // A change merged to main after the release was cut.
  git(directory, "clone", "-q", origin, other);
  commitFile(other, "template/app.ts", "unreleased\n", "feat: after release");
  git(other, "push", "-q", "origin", "main");

  writeFileSync(join(runner, "template/package.json"), '{"v":"2.0.0"}\n');
  expect(pushTemplateTag("2.0.0", ["template/package.json"], runner)).toBe(
    true,
  );

  const show = (rev: string) => git(origin, "show", rev);
  expect(show("template-v2.0.0:template/app.ts")).toBe("released");
  expect(show("template-v2.0.0:template/package.json")).toBe('{"v":"2.0.0"}');
  expect(git(origin, "rev-parse", "template-v2.0.0^{commit}^")).toBe(released);
  expect(show("main:template/app.ts")).toBe("unreleased");
  expect(show("main:template/package.json")).toBe('{"v":"2.0.0"}');
});
