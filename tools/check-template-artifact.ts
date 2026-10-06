import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

/** Both package managers must consume the tarballs that the artifact bundles. */
export function checkTemplateArtifact(directory: string): void {
  const pkg = JSON.parse(
    readFileSync(join(directory, "package.json"), "utf-8"),
  );
  const npmLock = JSON.parse(
    readFileSync(join(directory, "package-lock.json"), "utf-8"),
  );
  const pnpmLock = parse(
    readFileSync(join(directory, "pnpm-lock.yaml"), "utf-8"),
  );
  const expected: Record<string, string> = {
    ...pkg.dependencies,
    ...pkg.overrides,
  };
  for (const [name, specifier] of Object.entries(expected)) {
    if (!specifier.startsWith("file:")) continue;
    const expectedPath = resolve(directory, specifier.slice(5));
    const npmEntries = Object.entries<{ resolved?: string }>(npmLock.packages)
      .filter(
        ([key]) =>
          key === `node_modules/${name}` ||
          key.endsWith(`/node_modules/${name}`),
      )
      .map(([, entry]) => entry.resolved);
    const pnpmEntries = Object.entries<{ resolution?: { tarball?: string } }>(
      pnpmLock.packages,
    )
      .filter(([key]) => key.startsWith(`${name}@`))
      .map(([, entry]) => entry.resolution?.tarball);
    for (const [manager, entries] of [
      ["npm", npmEntries],
      ["pnpm", pnpmEntries],
    ] as const) {
      assert(entries.length > 0, `${manager} lock is missing bundled ${name}`);
      for (const resolved of entries) {
        assert(
          typeof resolved === "string" && resolved.startsWith("file:"),
          `${manager} must resolve ${name} to ${specifier}, got ${resolved}`,
        );
        assert.equal(
          resolve(directory, resolved.slice(5)),
          expectedPath,
          `${manager} resolves the wrong ${name} tarball`,
        );
      }
    }
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  checkTemplateArtifact(resolve(process.argv[2] ?? "pr-template"));
  console.log("Both template lockfiles resolve the bundled SDK tarballs");
}
