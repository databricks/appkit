import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const tsc = path.join(
  path.dirname(
    createRequire(import.meta.url).resolve("typescript/package.json"),
  ),
  "bin",
  "tsc",
);

interface TypeScriptDiagnostic {
  file: string | null;
  line: number;
  code: string;
  message: string;
}

/** Runs the compiler binary and keeps file locations and codes for negative type probes. */
export function typecheckProject(
  directory: string,
  config: {
    extends?: string;
    compilerOptions: Record<string, unknown>;
    files: readonly string[];
    include?: string[];
  },
): TypeScriptDiagnostic[] {
  const configFile = path.join(directory, "tsconfig.json");
  writeFileSync(configFile, JSON.stringify(config));
  const result = spawnSync(
    process.execPath,
    [tsc, "-p", configFile, "--pretty", "false"],
    { cwd: directory, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.status === 0) return [];
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (!output || (result.status !== 1 && result.status !== 2)) {
    throw new Error(`TypeScript exited with ${result.status}: ${output}`);
  }

  const diagnostics: TypeScriptDiagnostic[] = [];
  for (const text of output.split("\n")) {
    const match = /^(?:(.+)\((\d+),\d+\): )?error (TS\d+): (.*)$/.exec(text);
    if (match) {
      diagnostics.push({
        file: match[1] ? path.resolve(directory, match[1]) : null,
        line: Number(match[2] ?? 0),
        code: match[3],
        message: match[4],
      });
    } else {
      const previous = diagnostics.at(-1);
      if (!previous || !/^\s+/.test(text)) {
        throw new Error(`Unexpected TypeScript diagnostic: ${text}`);
      }
      previous.message += ` ${text.trim()}`;
    }
  }
  return diagnostics;
}
