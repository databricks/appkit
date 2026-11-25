import fs from "node:fs";
import path from "node:path";

import { typecheckProject } from "../../../../../../tools/typecheck-project";

const packageRoot =
  path.basename(process.cwd()) === "appkit-ui"
    ? process.cwd()
    : path.join(process.cwd(), "packages", "appkit-ui");

/**
 * Type-checks `source` against the package tsconfig and returns the
 * diagnostics as `line TScode message`. TypeScript 7 has no in-process compiler API, so
 * the probe is written to a scratch directory one level below the package
 * root (relative imports such as `../src/...` resolve from there) and checked
 * with the `tsc` binary.
 */
export function compileTypeProbe(
  source: string,
  options: { types?: string[] } = {},
): string[] {
  const dir = fs.mkdtempSync(path.join(packageRoot, ".type-probe-"));
  try {
    const probe = path.join(dir, "probe.ts");
    fs.writeFileSync(probe, source);
    return typecheckProject(dir, {
      extends: "../tsconfig.json",
      compilerOptions: { noEmit: true, types: options.types },
      files: ["probe.ts"],
      include: [],
    }).map(({ file, line, code, message }) => {
      const where = file === probe ? line : (file ?? "global");
      return `${where} ${code} ${message}`;
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
