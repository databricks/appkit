import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const packageRoot =
  path.basename(process.cwd()) === "appkit-ui"
    ? process.cwd()
    : path.join(process.cwd(), "packages", "appkit-ui");

const tsc = path.join(
  path.dirname(
    createRequire(import.meta.url).resolve("typescript/package.json"),
  ),
  "bin",
  "tsc",
);

/**
 * Type-checks `source` against the package tsconfig and returns the
 * diagnostics, one per line. TypeScript 7 has no in-process compiler API, so
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
    fs.writeFileSync(path.join(dir, "probe.ts"), source);
    fs.writeFileSync(
      path.join(dir, "tsconfig.json"),
      JSON.stringify({
        extends: "../tsconfig.json",
        compilerOptions: { noEmit: true, types: options.types },
        files: ["probe.ts"],
        include: [],
      }),
    );
    try {
      execFileSync(
        process.execPath,
        [tsc, "-p", path.join(dir, "tsconfig.json"), "--pretty", "false"],
        { encoding: "utf8", stdio: "pipe" },
      );
      return [];
    } catch (error) {
      const { stdout, stderr } = error as { stdout?: string; stderr?: string };
      const output = `${stdout ?? ""}${stderr ?? ""}`.trim();
      if (!output) throw error;
      return output.split("\n");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
