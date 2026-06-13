#!/usr/bin/env tsx
/**
 * Validates that template/package-lock.json resolves every dependency from the
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
 * source types (`git+ssh://`, `file:`, `http://`, links), since none of those
 * satisfy "https URL whose host is registry.npmjs.org".
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const ALLOWED_REGISTRY_HOST = "registry.npmjs.org";

const errors: string[] = [];

// --- Lockfile resolved URLs (core check) ---
// lockfileVersion 3: dependencies live only in the `packages` map. Entries
// without a `resolved` field are the root ("") and workspace/link entries —
// they are not registry fetches, so skip them.
const lock = JSON.parse(
  readFileSync(join(ROOT, "template/package-lock.json"), "utf-8"),
);

const packages: Record<string, { resolved?: string }> = lock.packages ?? {};
for (const [pkgKey, entry] of Object.entries(packages)) {
  const resolved = entry.resolved;
  if (!resolved) continue;

  let url: URL | undefined;
  try {
    url = new URL(resolved);
  } catch {
    // Not a parseable URL (e.g. a bare path) — treat as non-public.
  }

  if (url?.protocol !== "https:" || url.host !== ALLOWED_REGISTRY_HOST) {
    errors.push(
      `Non-public registry in template/package-lock.json: "${pkgKey || "<root>"}" ` +
        `resolves to ${resolved} (expected https://${ALLOWED_REGISTRY_HOST}/...).`,
    );
  }
}

// --- Template .npmrc (belt-and-suspenders) ---
// No template/.npmrc exists today; only validate it if one is added later.
const npmrcPath = join(ROOT, "template/.npmrc");
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
          `Non-public registry in template/.npmrc: "${line}" ` +
            `(expected https://${ALLOWED_REGISTRY_HOST}/).`,
        );
      }
      continue;
    }

    // `//<host>/...:_authToken=...` style auth lines.
    const authMatch = line.match(/^\/\/([^/]+)\/.*:_authToken\s*=/);
    if (authMatch && authMatch[1] !== ALLOWED_REGISTRY_HOST) {
      errors.push(
        `Auth token for non-public registry in template/.npmrc: "${line}".`,
      );
    }
  }
}

if (errors.length) {
  for (const e of errors) console.error(e);
  process.exit(1);
}

console.log(
  `✓ template/package-lock.json references only the public npm registry`,
);
