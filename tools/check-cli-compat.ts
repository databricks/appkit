#!/usr/bin/env tsx
/**
 * Validates that cli-compat.json is well-formed:
 *  - Valid JSON
 *  - "next" key is required
 *  - All keys are "next" or valid semver (X.Y.Z)
 *  - All values have exactly "appkit" and "skills" fields with valid semver strings
 *  - No extra fields in entries
 *  - "next" appkit/skills versions are >= all versioned entries
 *  - Versioned keys are in ascending semver order
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const SEMVER = /^\d+\.\d+\.\d+$/;

export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

export function validateCliCompat(manifest: unknown): string[] {
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    Array.isArray(manifest)
  ) {
    return ["cli-compat.json must be a JSON object"];
  }

  const obj = manifest as Record<string, unknown>;

  if (!("next" in obj)) {
    return ['cli-compat.json must contain a "next" key'];
  }

  const versionedKeys = Object.keys(obj).filter((k) => k !== "next");
  if (versionedKeys.length === 0) {
    return [
      'cli-compat.json must contain at least one versioned CLI entry besides "next"',
    ];
  }

  const errors: string[] = [];

  for (const [key, value] of Object.entries(obj)) {
    if (key !== "next" && !SEMVER.test(key)) {
      errors.push(
        `Invalid key "${key}": must be "next" or a semver string (X.Y.Z)`,
      );
      continue;
    }

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

    const extraFields = Object.keys(entry).filter(
      (k) => k !== "appkit" && k !== "skills",
    );
    if (extraFields.length > 0) {
      errors.push(`"${key}" has unexpected fields: ${extraFields.join(", ")}`);
    }
  }

  // Stop early if structure validation failed — cross-entry checks assume valid entries
  if (errors.length > 0) {
    return errors;
  }

  // Validate that "next" versions are >= all versioned entries
  const nextEntry = obj.next as Record<string, string>;
  for (const [key, value] of Object.entries(obj)) {
    if (key === "next") continue;
    const entry = value as Record<string, string>;

    for (const field of ["appkit", "skills"] as const) {
      if (compareSemver(nextEntry[field], entry[field]) < 0) {
        errors.push(
          `"next.${field}" (${nextEntry[field]}) must be >= "${key}.${field}" (${entry[field]})`,
        );
      }
    }
  }

  // Validate versioned keys are in ascending semver order
  const sorted = [...versionedKeys].sort(compareSemver);
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i] !== versionedKeys[i]) {
      errors.push("Versioned keys must be in ascending semver order");
      break;
    }
  }

  return errors;
}

// CLI entrypoint
const raw = readFileSync(
  join(import.meta.dirname, "../cli-compat.json"),
  "utf-8",
);

let manifest: unknown;
try {
  manifest = JSON.parse(raw);
} catch {
  console.error("cli-compat.json is not valid JSON");
  process.exit(1);
}

const errors = validateCliCompat(manifest);
if (errors.length) {
  console.error("cli-compat.json validation failed:");
  for (const e of errors) {
    console.error(`  - ${e}`);
  }
  process.exit(1);
}
