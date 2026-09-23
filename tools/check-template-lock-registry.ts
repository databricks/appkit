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
 *                 template/pnpm-lock.yaml (the committed pnpm lock). Format is
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

const ROOT = join(import.meta.dirname, "..");
const ALLOWED_REGISTRY_HOST = "registry.npmjs.org";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    rewrite: { type: "boolean", default: false },
    "allow-file": { type: "boolean", default: false },
  },
});

const lockPath = positionals[0]
  ? resolve(ROOT, positionals[0])
  : join(ROOT, "template/pnpm-lock.yaml");
const lockLabel = relative(ROOT, lockPath) || lockPath;
const npmrcPath = join(dirname(lockPath), ".npmrc");
const npmrcLabel = relative(ROOT, npmrcPath) || npmrcPath;
const allowFile = values["allow-file"];

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

const errors: string[] = [];

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
// Validate it if present; currently only used by pnpm but good to check for both.
if (existsSync(npmrcPath)) {
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

if (errors.length) {
  for (const e of errors) console.error(e);
  process.exit(1);
}

console.log(`✓ ${lockLabel} references only the public npm registry`);

// --- npm package-lock.json format handler ---
function validateNpmLock(path: string, label: string): void {
  // lockfileVersion 3: dependencies live only in the `packages` map. Entries
  // without a `resolved` field are the root ("") and workspace/link entries —
  // they are not registry fetches, so skip them.
  const lock = JSON.parse(readFileSync(path, "utf-8"));

  const packages: Record<string, { resolved?: string }> = lock.packages ?? {};
  for (const [pkgKey, entry] of Object.entries(packages)) {
    const resolved = entry.resolved;
    if (!resolved) continue;
    // Bundled local tarballs (appkit/appkit-ui/lakebase) in a prepared artifact.
    if (allowFile && resolved.startsWith("file:")) continue;

    let url: URL | undefined;
    try {
      url = new URL(resolved);
    } catch {
      // Not a parseable URL (e.g. a bare path) — treat as non-public.
    }

    if (url?.protocol !== "https:" || url.host !== ALLOWED_REGISTRY_HOST) {
      errors.push(
        `Non-public registry in ${label}: "${pkgKey || "<root>"}" ` +
          `resolves to ${resolved} (expected https://${ALLOWED_REGISTRY_HOST}/...).`,
      );
    }
  }
}

// --- pnpm pnpm-lock.yaml format handler ---
function validatePnpmLock(path: string, label: string): void {
  // pnpm uses YAML format. The lockfile structure has:
  // - packages: map of resolved package specs with 'resolution' (tarball URL)
  // - snapshots: references to resolved versions (not used for URL validation)
  // Resolution URLs appear in the 'resolution' field as URLs or inline tarballs.
  const yaml = readFileSync(path, "utf-8");

  // Simplified YAML parsing for registry URL validation.
  // We look for 'resolution:' entries that contain URLs.
  const resolutionPattern =
    /resolution:\s*\{?(?:tarball:\s*)?['"]?(https?:\/\/[^\s'"}\n]+)/gm;
  let match;
  while ((match = resolutionPattern.exec(yaml)) !== null) {
    const resolvedUrl = match[1];

    // Bundled local tarballs in a prepared artifact.
    if (allowFile && resolvedUrl.startsWith("file:")) continue;

    let url: URL | undefined;
    try {
      url = new URL(resolvedUrl);
    } catch {
      // Not a parseable URL — treat as non-public.
    }

    if (url?.protocol !== "https:" || url.host !== ALLOWED_REGISTRY_HOST) {
      errors.push(
        `Non-public registry in ${label}: tarball ` +
          `resolves to ${resolvedUrl} (expected https://${ALLOWED_REGISTRY_HOST}/...).`,
      );
    }
  }
}
