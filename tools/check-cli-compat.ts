#!/usr/bin/env tsx
/**
 * Validates that cli-compat.json is well-formed:
 *  - Valid JSON
 *  - "next" key is required
 *  - All keys are "next" or valid semver (X.Y.Z)
 *  - All values have "appkit" and "skills" fields with valid semver strings
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const SEMVER = /^\d+\.\d+\.\d+(-[\w.]+)?$/;

const raw = readFileSync(
  join(import.meta.dirname, "../cli-compat.json"),
  "utf-8",
);

let manifest: Record<string, unknown>;
try {
  manifest = JSON.parse(raw);
} catch {
  console.error("cli-compat.json is not valid JSON");
  process.exit(1);
}

if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
  console.error("cli-compat.json must be a JSON object");
  process.exit(1);
}

if (!("next" in manifest)) {
  console.error('cli-compat.json must contain a "next" key');
  process.exit(1);
}

const errors: string[] = [];

for (const [key, value] of Object.entries(manifest)) {
  // Validate key
  if (key !== "next" && !SEMVER.test(key)) {
    errors.push(`Invalid key "${key}": must be "next" or a semver string (X.Y.Z)`);
    continue;
  }

  // Validate value shape
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    errors.push(`Value for "${key}" must be an object`);
    continue;
  }

  const entry = value as Record<string, unknown>;

  if (typeof entry.appkit !== "string" || !SEMVER.test(entry.appkit)) {
    errors.push(
      `"${key}.appkit" must be a valid semver string, got: ${JSON.stringify(entry.appkit)}`,
    );
  }

  if (typeof entry.skills !== "string" || !SEMVER.test(entry.skills)) {
    errors.push(
      `"${key}.skills" must be a valid semver string, got: ${JSON.stringify(entry.skills)}`,
    );
  }
}

if (errors.length) {
  console.error("cli-compat.json validation failed:");
  for (const e of errors) {
    console.error(`  - ${e}`);
  }
  process.exit(1);
}
