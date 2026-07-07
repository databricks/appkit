#!/usr/bin/env tsx
/**
 * Validates that a template package-lock.json resolves every dependency from the
 * public npm registry, and nothing else.
 *
 * The template is the app scaffold shipped to users via `databricks apps init`,
 * and its lockfile pins exactly where each dependency is fetched from (the
 * `resolved` field on every package entry). If a private/internal registry
 * (Artifactory, JFrog, GitHub Packages, Verdaccio, an internal mirror) ever
 * leaks in — e.g. because the lockfile was regenerated on a machine with a
 * custom `.npmrc` — scaffolded apps would either fail `npm install` (no access)
 * or silently pull from a non-public source. This check fails CI before that
 * ships.
 *
 * The single https + host rule on each `resolved` URL also rejects non-registry
 * source types (`git+ssh://`, `http://`, links), since none of those satisfy
 * "https URL whose host is registry.npmjs.org".
 *
 * Usage:
 *   tsx tools/check-template-lock-registry.ts [lockfile] [--rewrite] [--allow-file]
 *
 *   lockfile      Optional path (relative to repo root or absolute). Defaults to
 *                 template/package-lock.json (the committed lock).
 *   --rewrite     Rewrite JFrog/Artifactory `resolved` URLs back to the public
 *                 npm registry before validating. The release pipeline builds
 *                 the template artifact on a protected runner whose npm is
 *                 pointed at JFrog (see .github/actions/setup-jfrog-npm), which
 *                 bakes internal URLs into the regenerated lock. JFrog is a
 *                 pull-through mirror of npmjs.org, so the tarball bytes and
 *                 `integrity` hashes are identical and only the host + base path
 *                 must change.
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
  : join(ROOT, "template/package-lock.json");
const lockLabel = relative(ROOT, lockPath) || lockPath;
const npmrcPath = join(dirname(lockPath), ".npmrc");
const npmrcLabel = relative(ROOT, npmrcPath) || npmrcPath;
const allowFile = values["allow-file"];

const errors: string[] = [];

// --- Optional rewrite: JFrog/Artifactory npm base -> public registry ---
// Matches the npm virtual-repo base configured by setup-jfrog-npm
// (https://databricks.jfrog.io/artifactory/api/npm/<repo>/). The path after the
// base mirrors npmjs.org exactly (including scoped and aliased packages such as
// rolldown-vite), so swapping the base is correct. Operates on the raw text so
// the rest of the lockfile is byte-for-byte unchanged.
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

// --- Lockfile resolved URLs (core check) ---
// lockfileVersion 3: dependencies live only in the `packages` map. Entries
// without a `resolved` field are the root ("") and workspace/link entries —
// they are not registry fetches, so skip them.
const lock = JSON.parse(readFileSync(lockPath, "utf-8"));

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
      `Non-public registry in ${lockLabel}: "${pkgKey || "<root>"}" ` +
        `resolves to ${resolved} (expected https://${ALLOWED_REGISTRY_HOST}/...).`,
    );
  }
}

// --- Template .npmrc (belt-and-suspenders) ---
// No template/.npmrc exists today; only validate it if one is added later.
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
