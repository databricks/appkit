import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Keep package-manager selection available when users initialize a static variant. */
export function preservePackageManagerArtifacts(
  source: string,
  output: string,
): void {
  for (const file of [
    "app.yaml.tmpl",
    "README.md.tmpl",
    "package-lock.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    ".npmrc",
  ]) {
    copyFileSync(join(source, file), join(output, file));
  }

  const original = JSON.parse(
    readFileSync(join(source, "package.json"), "utf-8"),
  );
  const packagePath = join(output, "package.json");
  const rendered = JSON.parse(readFileSync(packagePath, "utf-8"));
  for (const field of [
    "packageManager",
    "scripts",
    "overrides",
    "optionalDependencies",
  ]) {
    rendered[field] = original[field];
  }
  writeFileSync(packagePath, `${JSON.stringify(rendered, null, 2)}\n`);
}
