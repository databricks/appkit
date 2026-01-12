import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Package = {
  name: string;
  versions: string[];
  paths: string[];
  license: string;
  homepage?: string;
};

type PackageJson = {
  dependencies?: Record<string, string>;
};

// Packages whose direct dependencies we want to include in published artifacts
export const PUBLISHED_PACKAGES = [
  "packages/appkit",
  "packages/appkit-ui",
  "packages/shared",
];

export function getDirectDependencies(): Set<string> {
  const directDeps = new Set<string>();

  for (const pkgPath of PUBLISHED_PACKAGES) {
    const pkgJsonPath = join(process.cwd(), pkgPath, "package.json");
    try {
      const content = readFileSync(pkgJsonPath, "utf8");
      const pkgJson: PackageJson = JSON.parse(content);

      if (pkgJson.dependencies) {
        for (const depName of Object.keys(pkgJson.dependencies)) {
          if (!pkgJson.dependencies[depName].startsWith("workspace:")) {
            directDeps.add(depName);
          }
        }
      }
    } catch (err) {
      console.error(`Warning: Could not read ${pkgJsonPath}:`, err);
    }
  }

  return directDeps;
}

/**
 * Fetches license data from pnpm and filters to only include direct dependencies
 * of published packages.
 */
export function getDirectDependencyLicenses(): Package[] {
  const output = execSync("pnpm licenses list --json --production", {
    encoding: "utf8",
  });
  const licenses: Record<string, Package[]> = JSON.parse(output);
  const directDeps = getDirectDependencies();

  const dependencies: Package[] = [];

  for (const [licenseName, packages] of Object.entries(licenses)) {
    for (const pkg of packages) {
      if (directDeps.has(pkg.name)) {
        dependencies.push({ ...pkg, license: licenseName });
      }
    }
  }

  return dependencies;
}
