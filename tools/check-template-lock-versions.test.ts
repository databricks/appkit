import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";
import { stringify } from "yaml";

import { verifyLockVersions } from "./check-template-lock-versions";

const directories: string[] = [];
type Format = "npm" | "pnpm";

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Builds a lockfile fixture resolving each package to the given version. pnpm
// versions carry a peer suffix the verifier must strip.
function writeLock(format: Format, versions: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), "appkit-lock-versions-test-"));
  directories.push(directory);
  const path = join(
    directory,
    format === "npm" ? "package-lock.json" : "pnpm-lock.yaml",
  );
  if (format === "npm") {
    const packages: Record<string, unknown> = { "": { name: "template" } };
    for (const [pkg, version] of Object.entries(versions)) {
      packages[`node_modules/${pkg}`] = { version };
    }
    writeFileSync(path, JSON.stringify({ lockfileVersion: 3, packages }));
  } else {
    const dependencies: Record<string, unknown> = {};
    for (const [pkg, version] of Object.entries(versions)) {
      dependencies[pkg] = {
        specifier: version,
        version: `${version}(react@19.2.4)`,
      };
    }
    writeFileSync(
      path,
      stringify({
        lockfileVersion: "9.0",
        importers: { ".": { dependencies } },
      }),
    );
  }
  return path;
}

const EXPECTED = {
  "@databricks/appkit": "0.80.0",
  "@databricks/appkit-ui": "0.80.0",
};

describe.each(["npm", "pnpm"] as const)("%s lock", (format) => {
  test("passes when both packages resolve the expected version", () => {
    const lock = writeLock(format, EXPECTED);
    const result = verifyLockVersions([lock], EXPECTED);
    expect(result.ok).toBe(true);
    expect(result.mismatches).toEqual([]);
  });

  test.each(["@databricks/appkit", "@databricks/appkit-ui"])(
    "reports a mismatch when %s is pinned to an old version",
    (stale) => {
      const lock = writeLock(format, { ...EXPECTED, [stale]: "0.76.1" });
      const result = verifyLockVersions([lock], EXPECTED);
      expect(result.ok).toBe(false);
      expect(result.mismatches).toEqual([
        { lockfile: lock, package: stale, found: "0.76.1", expected: "0.80.0" },
      ]);
    },
  );

  test("reports a mismatch when a package is missing from the lockfile", () => {
    const lock = writeLock(format, { "@databricks/appkit": "0.80.0" });
    const result = verifyLockVersions([lock], EXPECTED);
    expect(result.ok).toBe(false);
    expect(result.mismatches).toEqual([
      {
        lockfile: lock,
        package: "@databricks/appkit-ui",
        found: null,
        expected: "0.80.0",
      },
    ]);
  });
});

test("catches the Phase-1 regression: pnpm lock stale while package.json is new", () => {
  // npm lock regenerated to the new version, pnpm lock left on the old one.
  const npmLock = writeLock("npm", EXPECTED);
  const pnpmLock = writeLock("pnpm", {
    "@databricks/appkit": "0.76.1",
    "@databricks/appkit-ui": "0.76.1",
  });
  const result = verifyLockVersions([npmLock, pnpmLock], EXPECTED);
  expect(result.ok).toBe(false);
  expect(result.mismatches).toEqual([
    {
      lockfile: pnpmLock,
      package: "@databricks/appkit",
      found: "0.76.1",
      expected: "0.80.0",
    },
    {
      lockfile: pnpmLock,
      package: "@databricks/appkit-ui",
      found: "0.76.1",
      expected: "0.80.0",
    },
  ]);
});
