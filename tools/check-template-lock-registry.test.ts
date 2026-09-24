import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, test } from "vitest";
import { stringify } from "yaml";

const root = resolve(import.meta.dirname, "..");
const directories: string[] = [];
type Format = "npm" | "pnpm";

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function runCheck(args: string[]) {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      join(root, "node_modules/tsx/dist/loader.mjs"),
      join(root, "tools/check-template-lock-registry.ts"),
      ...args,
    ],
    { encoding: "utf-8", timeout: 10_000 },
  );
  if (result.error) throw result.error;
  expect(result.signal).toBeNull();
  return result;
}

function checkFixture(format: Format, document: unknown, args: string[] = []) {
  const directory = mkdtempSync(join(tmpdir(), "appkit-lock-registry-test-"));
  directories.push(directory);
  const path = join(
    directory,
    format === "npm" ? "package-lock.json" : "pnpm-lock.yaml",
  );
  writeFileSync(
    path,
    format === "npm" ? JSON.stringify(document) : stringify(document),
  );
  return runCheck([path, ...args]);
}

function lock(format: Format, packages: unknown) {
  return { lockfileVersion: format === "npm" ? 3 : "9.0", packages };
}

function integrity(algorithm: string): string {
  return `${algorithm}-${createHash(algorithm).update("template fixture").digest("base64")}`;
}

describe.each(["npm", "pnpm"] as const)("%s lock schema", (format) => {
  test.each([null, [], 42, false, "invalid"])(
    "rejects a non-object document: %j",
    (document) => {
      const result = checkFixture(format, document);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("expected an object document");
      expect(result.stdout).not.toContain("✓");
    },
  );

  test.each([undefined, null, [], 42, false, "invalid"])(
    "rejects missing or non-object packages: %j",
    (packages) => {
      const result = checkFixture(format, lock(format, packages));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("packages must be an object");
      expect(result.stdout).not.toContain("✓");
    },
  );

  test.each([null, [], "invalid"])(
    "rejects a non-object package entry: %j",
    (entry) => {
      const result = checkFixture(format, lock(format, { example: entry }));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("must be an object");
    },
  );

  test("accepts an object map for a project without dependencies", () => {
    expect(checkFixture(format, lock(format, {})).status).toBe(0);
  });

  test.each([
    ["https://registry.npmjs.org/example/-/example-1.0.0.tgz", [], 0],
    ["file:./example-1.0.0.tgz", [], 1],
    ["file:./example-1.0.0.tgz", ["--allow-file"], 0],
  ] as const)(
    "preserves tarball handling for %s with %j",
    (tarball, flags, status) => {
      const packages =
        format === "npm"
          ? { "node_modules/example": { resolved: tarball } }
          : { "example@1.0.0": { resolution: { tarball } } };
      expect(
        checkFixture(format, lock(format, packages), [...flags]).status,
      ).toBe(status);
    },
  );
});

test.each([
  undefined,
  null,
  [],
  "invalid",
  {},
  { unknown: true },
  { integrity: false },
  { integrity: "" },
  { integrity: "not-an-integrity-hash" },
  { integrity: `sha512-${Buffer.from("short digest").toString("base64")}` },
  { integrity: integrity("sha512"), tarball: null },
  { integrity: integrity("sha512"), tarball: false },
  { integrity: integrity("sha512"), tarball: "" },
])("pnpm rejects malformed resolution %j", (resolution) => {
  const result = checkFixture(
    "pnpm",
    lock("pnpm", { "example@1.0.0": { resolution } }),
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(/Invalid (resolution|integrity|tarball)/);
  expect(result.stdout).not.toContain("✓");
});

test.each([
  integrity("sha1"),
  integrity("sha256"),
  integrity("sha384"),
  integrity("sha512"),
  integrity("sha512").replace(/=+$/, ""),
  `${integrity("sha1")} ${integrity("sha512")}`,
])("pnpm accepts a valid integrity-only resolution: %s", (hash) => {
  expect(
    checkFixture(
      "pnpm",
      lock("pnpm", {
        "example@1.0.0": { resolution: { integrity: hash } },
      }),
    ).status,
  ).toBe(0);
});

test("npm retains root, workspace link, and bundled entries", () => {
  expect(
    checkFixture(
      "npm",
      lock("npm", {
        "": { name: "template" },
        "node_modules/workspace": { link: true },
        "node_modules/bundled": { inBundle: true },
      }),
    ).status,
  ).toBe(0);
});

test("both committed locks still pass without being rewritten", () => {
  const paths = ["template/pnpm-lock.yaml", "template/package-lock.json"].map(
    (file) => join(root, file),
  );
  const before = paths.map((path) => readFileSync(path, "utf-8"));
  const result = runCheck([]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("✓ template/pnpm-lock.yaml");
  expect(result.stdout).toContain("✓ template/package-lock.json");
  expect(paths.map((path) => readFileSync(path, "utf-8"))).toEqual(before);
});
