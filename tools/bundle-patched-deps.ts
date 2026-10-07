import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { parse } from "yaml";

/**
 * Ship pnpm-patched dependencies inside a published tarball.
 *
 * A pnpm patch (`patchedDependencies`) is applied only at this monorepo's
 * install; it does not travel through a consumer's `npm install` /
 * `pnpm install`, so a deployed app would resolve the unpatched registry copy.
 * Instead, every patched package the tarball's package actually uses (directly
 * or transitively) is copied into the tarball's `node_modules` and listed in
 * `bundledDependencies`, so the consumer resolves the patched copy.
 *
 * A bundled package's own dependencies are NOT installed by the consumer's
 * package manager on its behalf, and under pnpm a bundled package can only
 * see what the tarball's package declares. So each of them must be a declared
 * dependency of the tarball's package, at the version the patched copy was
 * installed with; the plan adds missing ones and fails on conflicts.
 */

export interface PatchedDependency {
  /** The `patchedDependencies` key, e.g. `@scope/pkg@1.2.3`. */
  key: string;
  name: string;
  version: string;
}

export interface InstalledPackage {
  name: string;
  version: string;
  /** Real (symlink-resolved) package directory. */
  dir: string;
  dependencies: Record<string, string>;
}

export interface BundlePlan {
  /** Patched packages to copy into the tarball's node_modules. */
  bundle: InstalledPackage[];
  /** Dependencies to add to the tarball's package.json (name → exact version). */
  addDependencies: Record<string, string>;
}

/** Split a `patchedDependencies` key (`name@version`, name may be scoped). */
export function parsePatchKey(key: string): PatchedDependency {
  const at = key.lastIndexOf("@");
  if (at <= 0) {
    throw new Error(
      `patchedDependencies: "${key}" must pin an exact version (name@version)`,
    );
  }
  return { key, name: key.slice(0, at), version: key.slice(at + 1) };
}

/** Read `patchedDependencies` from pnpm-workspace.yaml (pnpm 11) or package.json. */
export function readPatchedDependencies(rootDir: string): PatchedDependency[] {
  const workspaceFile = path.join(rootDir, "pnpm-workspace.yaml");
  const fromWorkspace = fs.existsSync(workspaceFile)
    ? parse(fs.readFileSync(workspaceFile, "utf-8"))?.patchedDependencies
    : undefined;
  const rootPkg = JSON.parse(
    fs.readFileSync(path.join(rootDir, "package.json"), "utf-8"),
  );
  const entries = fromWorkspace ?? rootPkg.pnpm?.patchedDependencies ?? {};
  return Object.keys(entries).map(parsePatchKey);
}

/**
 * Find the installed package `name` as Node would resolve it from `fromDir`
 * (walking up `node_modules` directories), returning its real directory.
 */
export function findInstalledPackage(
  fromDir: string,
  name: string,
): InstalledPackage | undefined {
  let dir = fromDir;
  while (true) {
    const manifest = path.join(dir, "node_modules", name, "package.json");
    if (fs.existsSync(manifest)) {
      const realDir = fs.realpathSync(path.dirname(manifest));
      const json = JSON.parse(fs.readFileSync(manifest, "utf-8"));
      return {
        name,
        version: json.version,
        dir: realDir,
        dependencies: {
          ...json.dependencies,
          ...json.optionalDependencies,
        },
      };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Every installed package reachable from `roots` through dependencies,
 * keyed by name (a name may resolve to several versions in the tree).
 * Unresolvable names (e.g. uninstalled optional deps) are skipped.
 */
export function collectDependencyClosure(
  roots: Array<{ fromDir: string; names: string[] }>,
): Map<string, InstalledPackage[]> {
  const byName = new Map<string, InstalledPackage[]>();
  const seen = new Set<string>();
  const queue = roots.flatMap(({ fromDir, names }) =>
    names.map((name) => ({ fromDir, name })),
  );
  // Index loop rather than shift(): the queue grows while we walk it.
  for (let i = 0; i < queue.length; i++) {
    const { fromDir, name } = queue[i];
    const found = findInstalledPackage(fromDir, name);
    if (!found || seen.has(found.dir)) continue;
    seen.add(found.dir);
    byName.set(name, [...(byName.get(name) ?? []), found]);
    for (const dep of Object.keys(found.dependencies)) {
      queue.push({ fromDir: found.dir, name: dep });
    }
  }
  return byName;
}

/**
 * Decide which patched packages to bundle and which dependencies they need
 * declared. Throws when a patch can't be shipped correctly:
 * - the package is used but not at the patched version (stale patch entry),
 * - the patched version is installed without the patch applied,
 * - a bundled package needs a dependency at a different version than the one
 *   the tarball's package already declares.
 */
export function planBundledPatches(input: {
  patches: PatchedDependency[];
  closure: Map<string, InstalledPackage[]>;
  /** Final dependencies of the tarball's package.json. */
  declared: Record<string, string>;
  /** Installed version of a declared dependency, as the package resolves it. */
  resolveDeclaredVersion: (name: string) => string | undefined;
}): BundlePlan {
  const { patches, closure, declared, resolveDeclaredVersion } = input;
  const bundle: InstalledPackage[] = [];

  for (const patch of patches) {
    const installed = closure.get(patch.name);
    if (!installed) continue; // patch targets something this package doesn't use
    const match = installed.find((p) => p.version === patch.version);
    if (!match) {
      throw new Error(
        `bundled patches: ${patch.name} is installed at ${installed
          .map((p) => p.version)
          .join(", ")} but the patch targets ${patch.version}. ` +
          `Update the "${patch.key}" entry in patchedDependencies.`,
      );
    }
    // pnpm stores patched packages under a "_patch_hash=" directory.
    if (!match.dir.includes("_patch_hash=")) {
      throw new Error(
        `bundled patches: ${patch.key} is installed without the patch applied ` +
          `(${match.dir}). Run pnpm install.`,
      );
    }
    bundle.push(match);
  }

  const bundledNames = new Set(bundle.map((p) => p.name));
  const addDependencies: Record<string, string> = {};
  for (const pkg of bundle) {
    for (const dep of Object.keys(pkg.dependencies)) {
      if (bundledNames.has(dep)) continue;
      const needed = findInstalledPackage(pkg.dir, dep)?.version;
      if (!needed) continue; // uninstalled optional dependency
      if (declared[dep] !== undefined) {
        const have = resolveDeclaredVersion(dep);
        if (have !== undefined && have !== needed) {
          throw new Error(
            `bundled patches: ${pkg.name} needs ${dep}@${needed}, but the ` +
              `package declares ${dep}@${declared[dep]} (installed ${have}).`,
          );
        }
        continue;
      }
      const prior = addDependencies[dep];
      if (prior !== undefined && prior !== needed) {
        throw new Error(
          `bundled patches: conflicting versions of ${dep} needed (${prior}, ${needed}).`,
        );
      }
      addDependencies[dep] = needed;
    }
  }

  // Bundled packages must be listed in dependencies to be packed + installed.
  for (const pkg of bundle) {
    if (declared[pkg.name] === undefined) {
      addDependencies[pkg.name] = pkg.version;
    }
  }

  return { bundle, addDependencies };
}

/** Content hash of a package directory (relative paths + file bytes). */
export function hashPackageDir(dir: string): string {
  const hash = createHash("sha256");
  const walk = (current: string) => {
    for (const entry of fs
      .readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === "node_modules") continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        hash.update(path.relative(dir, full));
        hash.update(fs.readFileSync(full));
      }
    }
  };
  walk(dir);
  return hash.digest("hex");
}
