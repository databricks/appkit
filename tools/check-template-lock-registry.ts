#!/usr/bin/env tsx
/**
 * Validates that template lockfiles (package-lock.json and pnpm-lock.yaml)
 * resolve every dependency from the public npm registry, and nothing else.
 *
 * The template is the app scaffold shipped to users via `databricks apps init`,
 * and its lockfiles pin exactly where each dependency is fetched from (the
 * `resolved` field in npm format or `resolution`/tarball URLs in pnpm format).
 * If a private/internal registry (Artifactory, JFrog, GitHub Packages, Verdaccio,
 * an internal mirror) ever leaks in — e.g. because the lockfile was regenerated
 * on a machine with a custom `.npmrc` — scaffolded apps would either
 * fail install (no access) or silently pull from a non-public source. This check
 * fails CI before that ships.
 *
 * Usage:
 *   tsx tools/check-template-lock-registry.ts [lockfile] [--rewrite] [--allow-file]
 *
 *   lockfile      Optional path (relative to repo root or absolute). Defaults to
 *                 both committed template locks. Format is
 *                 detected by filename (.yaml/.yml = pnpm; .json = npm).
 *   --rewrite     Rewrite JFrog/Artifactory URLs back to the public npm registry
 *                 before validating. The release pipeline builds the template
 *                 on a protected runner whose npm is pointed at JFrog
 *                 (see .github/actions/setup-jfrog-npm), which bakes internal
 *                 URLs into the regenerated locks. JFrog is a pull-through mirror
 *                 of npmjs.org, so the tarball bytes and integrity hashes are
 *                 identical and only the host + base path must change.
 *   --allow-file  Permit `file:` resolved entries (bundled appkit/appkit-ui/
 *                 lakebase tarballs that prepare-template-artifact.ts pins). Used
 *                 for the prepared artifact lock; never for the committed lock.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

import { parse as parseYaml } from "yaml";

const ROOT = join(import.meta.dirname, "..");
const ALLOWED_REGISTRY_HOST = "registry.npmjs.org";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    rewrite: { type: "boolean", default: false },
    "allow-file": { type: "boolean", default: false },
  },
});

const allowFile = values["allow-file"];

// Default: validate both lockfiles (pnpm and npm) if no explicit path given.
// If a path is given, validate only that one.
const lockPaths: Array<{
  path: string;
  label: string;
  npmrcPath: string;
  npmrcLabel: string;
}> = [];

if (positionals[0]) {
  // Explicit lockfile path
  const path = resolve(ROOT, positionals[0]);
  const label = relative(ROOT, path) || path;
  lockPaths.push({
    path,
    label,
    npmrcPath: join(dirname(path), ".npmrc"),
    npmrcLabel:
      relative(ROOT, join(dirname(path), ".npmrc")) ||
      join(dirname(path), ".npmrc"),
  });
} else {
  // Default: both lockfiles in template/
  lockPaths.push({
    path: join(ROOT, "template/pnpm-lock.yaml"),
    label: "template/pnpm-lock.yaml",
    npmrcPath: join(ROOT, "template/.npmrc"),
    npmrcLabel: "template/.npmrc",
  });
  lockPaths.push({
    path: join(ROOT, "template/package-lock.json"),
    label: "template/package-lock.json",
    npmrcPath: join(ROOT, "template/.npmrc"),
    npmrcLabel: "template/.npmrc",
  });
}

const errors: string[] = [];
const validatedNpmrcPaths = new Set<string>();

// Process each lockfile
for (const {
  path: lockPath,
  label: lockLabel,
  npmrcPath,
  npmrcLabel,
} of lockPaths) {
  const errorCountBefore = errors.length;
  // Detect format by filename
  const isPnpmLock = lockPath.endsWith(".yaml") || lockPath.endsWith(".yml");
  const isNpmLock = lockPath.endsWith(".json");

  if (!isPnpmLock && !isNpmLock) {
    console.error(
      `Unknown lockfile format: ${lockLabel}. Expected .yaml, .yml, or .json.`,
    );
    process.exit(1);
  }

  if (!existsSync(lockPath)) {
    console.error(
      `Lockfile not found: ${lockLabel}. Run 'pnpm install' or 'npm install' to generate it.`,
    );
    process.exit(1);
  }

  // --- Optional rewrite: JFrog/Artifactory base -> public registry ---
  // Matches the virtual-repo bases configured by setup-jfrog-npm for both npm and pnpm.
  // npm: https://databricks.jfrog.io/artifactory/api/npm/<repo>/
  // pnpm: same URLs may appear in resolution/tarball fields
  // Both use the same pull-through mirror, so the tarball bytes and integrity hashes
  // are identical; only the host + base path must change.
  if (values.rewrite) {
    const before = readFileSync(lockPath, "utf-8");
    const JFROG_NPM_BASE =
      /https:\/\/databricks\.jfrog\.io\/artifactory\/api\/npm\/[^/]+\//g;
    const count = (before.match(JFROG_NPM_BASE) || []).length;
    if (count > 0) {
      writeFileSync(
        lockPath,
        before.replace(JFROG_NPM_BASE, `https://${ALLOWED_REGISTRY_HOST}/`),
      );
    }
    console.log(`Rewrote ${count} JFrog URL(s) to public npm in ${lockLabel}`);
  }

  if (isPnpmLock) {
    validatePnpmLock(lockPath, lockLabel);
  } else {
    validateNpmLock(lockPath, lockLabel);
  }

  // --- Template .npmrc (belt-and-suspenders) ---
  // Validate once per distinct .npmrc path (avoid duplicate errors when validating both locks).
  // Currently only used by pnpm but good to check for both.
  if (existsSync(npmrcPath) && !validatedNpmrcPaths.has(npmrcPath)) {
    validatedNpmrcPaths.add(npmrcPath);
    const lines = readFileSync(npmrcPath, "utf-8").split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#") || line.startsWith(";")) continue;

      // `registry=...` or scoped `@scope:registry=...`
      const registryMatch = line.match(
        /^(?:@[\w-]+\/?[\w-]*:)?registry\s*=\s*(.+)$/,
      );
      if (registryMatch) {
        const value = registryMatch[1].trim().replace(/\/+$/, "");
        if (value !== `https://${ALLOWED_REGISTRY_HOST}`) {
          errors.push(
            `Non-public registry in ${npmrcLabel}: "${line}" ` +
              `(expected https://${ALLOWED_REGISTRY_HOST}/).`,
          );
        }
        continue;
      }

      // `//<host>/...:_authToken=...` style auth lines.
      const authMatch = line.match(/^\/\/([^/]+)\/.*:_authToken\s*=/);
      if (authMatch && authMatch[1] !== ALLOWED_REGISTRY_HOST) {
        errors.push(
          `Auth token for non-public registry in ${npmrcLabel}: "${line}".`,
        );
      }
    }
  }

  if (errors.length === errorCountBefore) {
    console.log(`✓ ${lockLabel} references only the public npm registry`);
  }
}

if (errors.length) {
  for (const e of errors) console.error(e);
  process.exit(1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getPackages(
  lock: unknown,
  label: string,
): Record<string, unknown> | undefined {
  if (!isRecord(lock)) {
    errors.push(`Invalid lockfile in ${label}: expected an object document.`);
    return;
  }
  if (!isRecord(lock.packages)) {
    errors.push(`Invalid lockfile in ${label}: packages must be an object.`);
    return;
  }
  return lock.packages;
}

/** Lockfile integrity values use SRI hashes with base64-encoded digests. */
function isIntegrity(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  return value
    .trim()
    .split(/\s+/)
    .every((hash) => {
      const match = /^sha(1|256|384|512)-([A-Za-z0-9+/]+={0,2})$/.exec(hash);
      if (!match) return false;
      const digest = Buffer.from(match[2], "base64");
      const expectedBytes = match[1] === "1" ? 20 : Number(match[1]) / 8;
      const base64 = digest.toString("base64");
      return (
        digest.length === expectedBytes &&
        (base64 === match[2] || base64.replace(/=+$/, "") === match[2])
      );
    });
}

// --- npm package-lock.json format handler ---
function validateNpmLock(path: string, label: string): void {
  // lockfileVersion 3: dependencies live only in the `packages` map. Entries
  // without a `resolved` field are the root (""), link entries, or workspaces —
  // they are not registry fetches. Link entries have link: true. Root is "".
  const packages = getPackages(JSON.parse(readFileSync(path, "utf-8")), label);
  if (!packages) return;
  for (const [pkgKey, entry] of Object.entries(packages)) {
    if (!isRecord(entry)) {
      errors.push(`Invalid entry in ${label}: "${pkgKey}" must be an object.`);
      continue;
    }
    // Skip root, link entries, and bundled entries (these are not registry fetches)
    if (!("resolved" in entry)) {
      // Entries without resolved should be root, link, or workspace entries.
      // Fail closed: if it's not one of those special cases, it's an error.
      if (pkgKey === "" || entry.link === true || entry.inBundle === true)
        continue;
      // Non-link, non-root, non-bundled entry with no resolved → error
      errors.push(
        `Invalid entry in ${label}: "${pkgKey}" has no resolved field ` +
          `and is not a link, root, or bundled entry.`,
      );
      continue;
    }

    if (typeof entry.resolved !== "string" || !entry.resolved) {
      errors.push(
        `Invalid entry in ${label}: "${pkgKey}" must have a non-empty resolved string.`,
      );
      continue;
    }

    // Bundled local tarballs (appkit/appkit-ui/lakebase) in a prepared artifact.
    if (allowFile && entry.resolved.startsWith("file:")) continue;

    let url: URL | undefined;
    try {
      url = new URL(entry.resolved);
    } catch {
      // Not a parseable URL (e.g. a bare path) — treat as non-public.
    }

    if (url?.protocol !== "https:" || url.host !== ALLOWED_REGISTRY_HOST) {
      errors.push(
        `Non-public registry in ${label}: "${pkgKey || "<root>"}" ` +
          `resolves to ${entry.resolved} (expected https://${ALLOWED_REGISTRY_HOST}/...).`,
      );
    }
  }
}

// --- pnpm pnpm-lock.yaml format handler ---
function validatePnpmLock(path: string, label: string): void {
  // pnpm uses YAML format. The lockfile structure has:
  // - packages: map of resolved package specs with 'resolution' field
  // Resolution can be:
  //   - { integrity: "..." } - registry-derived, OK
  //   - { tarball: "..." } - must be https://registry.npmjs.org/... or file:
  //   - { type: "git", ... } or { type: "directory", ... } - error (fail closed)
  //   - missing entirely - error (fail closed)
  const packages = getPackages(parseYaml(readFileSync(path, "utf-8")), label);
  if (!packages) return;

  for (const [pkgKey, entry] of Object.entries(packages)) {
    if (!isRecord(entry)) {
      errors.push(`Invalid entry in ${label}: "${pkgKey}" must be an object.`);
      continue;
    }
    const res = entry.resolution;
    if (!isRecord(res)) {
      errors.push(
        `Invalid resolution in ${label}: "${pkgKey}" must have an object resolution.`,
      );
      continue;
    }

    // Check for non-registry types (git, directory, or unknown). Fail closed.
    if ("type" in res) {
      errors.push(
        `Non-registry resolution in ${label}: "${pkgKey}" has type "${res.type}" ` +
          `(expected registry-derived or file: tarball).`,
      );
      continue;
    }

    // An integrity-only registry resolution still needs a valid SRI digest.
    if (!("tarball" in res)) {
      if (!isIntegrity(res.integrity)) {
        errors.push(
          `Invalid integrity in ${label}: "${pkgKey}" requires a valid SRI hash when tarball is absent.`,
        );
      }
      continue;
    }

    // Validate tarball URL
    const tarball = res.tarball;
    if (typeof tarball !== "string" || !tarball) {
      errors.push(
        `Invalid tarball in ${label}: "${pkgKey}" must have a non-empty tarball string.`,
      );
      continue;
    }

    // Bundled local tarballs in a prepared artifact
    if (allowFile && tarball.startsWith("file:")) continue;

    let url: URL | undefined;
    try {
      url = new URL(tarball);
    } catch {
      // Not a parseable URL — treat as non-public
    }

    if (url?.protocol !== "https:" || url.host !== ALLOWED_REGISTRY_HOST) {
      errors.push(
        `Non-public registry in ${label}: "${pkgKey}" ` +
          `tarball resolves to ${tarball} (expected https://${ALLOWED_REGISTRY_HOST}/...).`,
      );
    }
  }
}
