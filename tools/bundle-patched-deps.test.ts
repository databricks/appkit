import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, expect, test } from "vitest";

import {
  collectDependencyClosure,
  findInstalledPackage,
  parsePatchKey,
  planBundledPatches,
  readPatchedDependencies,
} from "./bundle-patched-deps";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

/**
 * A pnpm-shaped tree: real packages live in `.pnpm/<id>/node_modules/<name>`
 * (patched ones under a `_patch_hash=` id) with their deps symlinked as
 * siblings; `consumer/node_modules/<name>` symlinks to the store.
 */
function pnpmTree(
  packages: Array<{
    name: string;
    version: string;
    patched?: boolean;
    deps?: Record<string, string>;
  }>,
  consumerDeps: string[],
) {
  const root = mkdtempSync(join(tmpdir(), "bundle-patched-"));
  temporaryDirectories.push(root);
  const store = join(root, "node_modules/.pnpm");
  const realDir = (name: string) => {
    const p = packages.find((x) => x.name === name);
    if (!p) throw new Error(`fixture is missing package ${name}`);
    const id = `${name.replace("/", "+")}@${p.version}${p.patched ? "_patch_hash=abc" : ""}`;
    return join(store, id, "node_modules", name);
  };
  for (const p of packages) {
    const dir = realDir(p.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: p.name,
        version: p.version,
        dependencies: p.deps,
      }),
    );
    for (const dep of Object.keys(p.deps ?? {})) {
      const link = join(dirname(dir), dep);
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(realDir(dep), link);
    }
  }
  const consumer = join(root, "consumer");
  for (const name of consumerDeps) {
    const link = join(consumer, "node_modules", name);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(realDir(name), link);
  }
  return consumer;
}

function plan(
  consumer: string,
  roots: string[],
  patches: string[],
  declared: Record<string, string>,
) {
  return planBundledPatches({
    patches: patches.map(parsePatchKey),
    closure: collectDependencyClosure([{ fromDir: consumer, names: roots }]),
    declared,
    resolveDeclaredVersion: (name) =>
      findInstalledPackage(consumer, name)?.version,
  });
}

test("parsePatchKey splits scoped and unscoped keys", () => {
  expect(parsePatchKey("@scope/pkg@1.2.3")).toEqual({
    key: "@scope/pkg@1.2.3",
    name: "@scope/pkg",
    version: "1.2.3",
  });
  expect(parsePatchKey("pkg@1.0.0").name).toBe("pkg");
  expect(() => parsePatchKey("@scope/pkg")).toThrow(/exact version/);
});

test("readPatchedDependencies reads pnpm-workspace.yaml, falling back to package.json", () => {
  const root = mkdtempSync(join(tmpdir(), "bundle-patched-"));
  temporaryDirectories.push(root);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ pnpm: { patchedDependencies: { "old@1.0.0": "p" } } }),
  );
  expect(readPatchedDependencies(root).map((p) => p.key)).toEqual([
    "old@1.0.0",
  ]);
  writeFileSync(
    join(root, "pnpm-workspace.yaml"),
    "patchedDependencies:\n  '@s/new@2.0.0': patches/x.patch\n",
  );
  expect(readPatchedDependencies(root).map((p) => p.key)).toEqual([
    "@s/new@2.0.0",
  ]);
});

test("bundles a directly used patch and declares its undeclared deps", () => {
  const consumer = pnpmTree(
    [
      { name: "a", version: "1.0.0", patched: true, deps: { b: "^2" } },
      { name: "b", version: "2.1.0" },
    ],
    ["a"],
  );
  const result = plan(consumer, ["a"], ["a@1.0.0"], { a: "1.0.0" });
  expect(result.bundle.map((p) => p.name)).toEqual(["a"]);
  expect(result.addDependencies).toEqual({ b: "2.1.0" });
});

test("bundles a transitively used patch and declares it", () => {
  const consumer = pnpmTree(
    [
      { name: "top", version: "1.0.0", deps: { "@s/deep": "1.0.0" } },
      { name: "@s/deep", version: "1.0.0", patched: true },
    ],
    ["top"],
  );
  const result = plan(consumer, ["top"], ["@s/deep@1.0.0"], { top: "1.0.0" });
  expect(result.bundle.map((p) => p.name)).toEqual(["@s/deep"]);
  expect(result.addDependencies).toEqual({ "@s/deep": "1.0.0" });
});

test("ignores patches on packages the tarball does not use", () => {
  const consumer = pnpmTree([{ name: "a", version: "1.0.0" }], ["a"]);
  const result = plan(consumer, ["a"], ["unused@1.0.0"], { a: "1.0.0" });
  expect(result).toEqual({ bundle: [], addDependencies: {} });
});

test("fails when the used version no longer matches the patch (stale entry)", () => {
  const consumer = pnpmTree([{ name: "a", version: "1.1.0" }], ["a"]);
  expect(() => plan(consumer, ["a"], ["a@1.0.0"], { a: "1.1.0" })).toThrow(
    /installed at 1.1.0 but the patch targets 1.0.0/,
  );
});

test("fails when the patched version is installed without the patch", () => {
  const consumer = pnpmTree([{ name: "a", version: "1.0.0" }], ["a"]);
  expect(() => plan(consumer, ["a"], ["a@1.0.0"], { a: "1.0.0" })).toThrow(
    /without the patch applied/,
  );
});

test("fails when a bundled package needs a different version than declared", () => {
  const consumer = pnpmTree(
    [
      { name: "a", version: "1.0.0", patched: true, deps: { b: "2.0.0" } },
      { name: "b", version: "2.0.0" },
    ],
    ["a"],
  );
  expect(() =>
    planBundledPatches({
      patches: [parsePatchKey("a@1.0.0")],
      closure: collectDependencyClosure([{ fromDir: consumer, names: ["a"] }]),
      declared: { a: "1.0.0", b: "3.0.0" },
      resolveDeclaredVersion: () => "3.0.0",
    }),
  ).toThrow(/needs b@2.0.0, but the package declares b@3.0.0/);
});
