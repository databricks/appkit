#!/usr/bin/env tsx
/**
 * Verifies that the template lockfiles resolve @databricks/appkit and
 * @databricks/appkit-ui to the version pinned in template/package.json.
 *
 * The template ships BOTH lockfiles (package-lock.json + pnpm-lock.yaml). The
 * release pipeline regenerates both on every version bump; if one is skipped,
 * scaffolded apps install an SDK version that mismatches package.json — the
 * exact Phase-1 regression. This parity check fails closed before that ships,
 * both in PR CI (via check-template-deps.ts) and at release time (via
 * publish-template-tag.ts).
 *
 * Usage:
 *   tsx tools/check-template-lock-versions.ts [lockfile...] [--version <v>]
 *
 *   lockfile    Lockfile paths (relative to repo root or absolute). Defaults to
 *               both committed template locks. Format detected by filename.
 *   --version   Expected version for both @databricks packages. Defaults to the
 *               versions pinned in template/package.json dependencies.
 */

import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { parse as parseYaml } from "yaml";

const ROOT = join(import.meta.dirname, "..");
const VERIFIED_PACKAGES = ["@databricks/appkit", "@databricks/appkit-ui"];

export interface VersionMismatch {
  lockfile: string;
  package: string;
  found: string | null;
  expected: string;
}

export interface VerifyResult {
  ok: boolean;
  mismatches: VersionMismatch[];
}

/**
 * Reads the resolved version of each `expected` package from each lockfile and
 * flags any that differ (or are missing). Pure: reads files, returns a report.
 */
export function verifyLockVersions(
  lockPaths: string[],
  expected: Record<string, string>,
): VerifyResult {
  const mismatches: VersionMismatch[] = [];
  for (const lockPath of lockPaths) {
    const resolved = readResolvedVersions(lockPath);
    for (const [pkg, want] of Object.entries(expected)) {
      const found = resolved[pkg] ?? null;
      if (found !== want) {
        mismatches.push({
          lockfile: lockPath,
          package: pkg,
          found,
          expected: want,
        });
      }
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolved versions keyed by package name, dispatched by lockfile format. */
function readResolvedVersions(lockPath: string): Record<string, string> {
  const content = readFileSync(lockPath, "utf-8");
  if (lockPath.endsWith(".yaml") || lockPath.endsWith(".yml")) {
    return readPnpmVersions(content);
  }
  return readNpmVersions(content);
}

// npm package-lock.json (lockfileVersion 3): the resolved version lives at
// packages["node_modules/<pkg>"].version.
function readNpmVersions(content: string): Record<string, string> {
  const lock: unknown = JSON.parse(content);
  const out: Record<string, string> = {};
  if (!isRecord(lock) || !isRecord(lock.packages)) return out;
  for (const pkg of VERIFIED_PACKAGES) {
    const entry = lock.packages[`node_modules/${pkg}`];
    if (isRecord(entry) && typeof entry.version === "string") {
      out[pkg] = entry.version;
    }
  }
  return out;
}

// pnpm-lock.yaml (v9): the root importer records the resolved version at
// importers["."].dependencies["<pkg>"].version. That field carries a
// peer-dependency suffix (e.g. "0.76.1(react@19.2.4)"); strip it at the first
// "(" to recover the bare semver, which semver never contains.
function readPnpmVersions(content: string): Record<string, string> {
  const lock: unknown = parseYaml(content);
  const out: Record<string, string> = {};
  if (!isRecord(lock) || !isRecord(lock.importers)) return out;
  const root = lock.importers["."];
  if (!isRecord(root)) return out;
  const deps = {
    ...(isRecord(root.dependencies) ? root.dependencies : {}),
    ...(isRecord(root.devDependencies) ? root.devDependencies : {}),
  };
  for (const pkg of VERIFIED_PACKAGES) {
    const entry = deps[pkg];
    if (isRecord(entry) && typeof entry.version === "string") {
      out[pkg] = entry.version.split("(")[0];
    }
  }
  return out;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { version: { type: "string" } },
  });

  const lockPaths = positionals.length
    ? positionals.map((p) => resolve(ROOT, p))
    : [
        join(ROOT, "template/pnpm-lock.yaml"),
        join(ROOT, "template/package-lock.json"),
      ];

  let expected: Record<string, string>;
  if (values.version) {
    expected = Object.fromEntries(
      VERIFIED_PACKAGES.map((pkg) => [pkg, values.version as string]),
    );
  } else {
    const templatePkg = JSON.parse(
      readFileSync(join(ROOT, "template/package.json"), "utf-8"),
    );
    const deps: Record<string, string> = templatePkg.dependencies ?? {};
    expected = Object.fromEntries(
      VERIFIED_PACKAGES.filter((pkg) => pkg in deps).map((pkg) => [
        pkg,
        deps[pkg],
      ]),
    );
  }

  const { ok, mismatches } = verifyLockVersions(lockPaths, expected);
  if (!ok) {
    for (const m of mismatches) {
      console.error(
        `Version mismatch in ${relative(ROOT, m.lockfile) || m.lockfile}: ` +
          `"${m.package}" resolves to ${m.found ?? "<missing>"} ` +
          `(expected ${m.expected}).`,
      );
    }
    process.exit(1);
  }
  for (const path of lockPaths) {
    console.log(
      `✓ ${relative(ROOT, path) || path} resolves @databricks/* to the pinned version`,
    );
  }
}
