#!/usr/bin/env tsx
/**
 * Validates that all dependencies in template/package.json use exact versions
 * (no ^, ~, >=, * prefixes). This prevents supply chain attacks during
 * template sync where npm install could pull unexpected transitive deps.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const pkg = JSON.parse(
  readFileSync(join(import.meta.dirname, "../template/package.json"), "utf-8"),
);

const deps: Record<string, string> = {
  ...pkg.dependencies,
  ...pkg.devDependencies,
};

const PINNED_VERSION = /^(npm:(@[\w-]+\/)?[\w.-]+@)?\d+\.\d+\.\d+(-[\w.]+)?$/;
const unpinned = Object.entries(deps).filter(
  ([, v]) => !PINNED_VERSION.test(v),
);

if (unpinned.length) {
  console.error(
    "Unpinned deps:",
    unpinned.map(([k, v]) => `${k}@${v}`).join(", "),
  );
  process.exit(1);
}
