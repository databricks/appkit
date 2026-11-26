import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { afterEach, expect, test } from "vitest";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "..");
const outputs: string[] = [];
afterEach(() => {
  for (const output of outputs.splice(0))
    rmSync(join(root, output), { recursive: true, force: true });
});

function scaffoldAppYaml(...flags: string[]): Record<string, unknown> {
  const output = `.smoke-test/app-yaml-${process.pid}-${outputs.length}`;
  outputs.push(output);
  execFileSync(
    process.execPath,
    [
      "--import",
      join(root, "node_modules/tsx/dist/loader.mjs"),
      join(root, "tools/smoke-test-template.ts"),
      "--output-dir",
      output,
      ...flags,
    ],
    { cwd: root, stdio: "pipe", timeout: 60_000 },
  );
  return parse(readFileSync(join(root, output, "app.yaml"), "utf-8"));
}

test(
  "with --all-plugins, app.yaml sets the database plugin's env beside the health check",
  {
    timeout: 60_000,
  },
  () => {
    const app = scaffoldAppYaml("--all-plugins");
    expect(app.health_check).toEqual({ path: "/health" });
    expect(app.env).toEqual([
      { name: "APPKIT_DB_MIGRATE_ON_START", value: "true" },
    ]);
  },
);

test(
  "without plugins, app.yaml has the health check and no env",
  {
    timeout: 60_000,
  },
  () => {
    const app = scaffoldAppYaml();
    expect(app.health_check).toEqual({ path: "/health" });
    expect(app).not.toHaveProperty("env");
  },
);
