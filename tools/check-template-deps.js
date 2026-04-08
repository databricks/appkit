#!/usr/bin/env node
/**
 * Validates that all dependencies in template/package.json use exact versions
 * (no ^, ~, >=, * prefixes). This prevents supply chain attacks during
 * template sync where npm install could pull unexpected transitive deps.
 */

const pkg = require("../template/package.json");
const deps = { ...pkg.dependencies, ...pkg.devDependencies };
const unpinned = Object.entries(deps).filter(([, v]) => /^[~^>=*]/.test(v));

if (unpinned.length) {
  console.error(
    "Unpinned deps:",
    unpinned.map(([k, v]) => `${k}@${v}`).join(", "),
  );
  process.exit(1);
}
