import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import { afterEach, expect, test } from "vitest";
import { parse } from "yaml";

import { checkTemplateArtifact } from "./check-template-artifact";
import { preservePackageManagerArtifacts } from "./template-artifacts";
import { selectSmokePackageManager } from "./template-smoke-runner";

const root = resolve(import.meta.dirname, "..");
const temporaryDirectories: string[] = [];
function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "appkit-template-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

test("static variants retain both package managers for the final init", () => {
  const output = scratch();
  const source = join(root, "template");
  const original = JSON.parse(
    readFileSync(join(source, "package.json"), "utf-8"),
  );
  writeFileSync(
    join(output, "package.json"),
    JSON.stringify({
      ...original,
      name: "rendered-analytics",
      packageManager: "npm@11.0.0",
      scripts: { build: "npm run build:client" },
    }),
  );
  preservePackageManagerArtifacts(source, output);
  const restored = JSON.parse(
    readFileSync(join(output, "package.json"), "utf-8"),
  );
  expect(restored.name).toBe("rendered-analytics");
  expect(restored.dependencies).toEqual(original.dependencies);
  expect(restored.scripts).toEqual(original.scripts);
  expect(restored.packageManager).toBe(original.packageManager);
  for (const file of [
    "pnpm-lock.yaml",
    "package-lock.json",
    "pnpm-workspace.yaml",
    "app.yaml.tmpl",
    "README.md.tmpl",
    ".npmrc",
  ]) {
    expect(readFileSync(join(output, file), "utf-8")).toBe(
      readFileSync(join(source, file), "utf-8"),
    );
  }
});

test.each(["npm", "pnpm"] as const)(
  "%s prebuild runs sync and forwards --wait to AppKit",
  (manager) => {
    const directory = scratch();
    const pkg = JSON.parse(
      readFileSync(join(root, "template/package.json"), "utf-8"),
    );
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({
        private: true,
        packageManager: pkg.packageManager,
        scripts: {
          prebuild: pkg.scripts.prebuild,
          sync: pkg.scripts.sync,
          typegen: pkg.scripts.typegen,
          build: "node -e ''",
        },
      }),
    );
    cpSync(join(root, "template/.npmrc"), join(directory, ".npmrc"));
    writeFileSync(join(directory, "pnpm-workspace.yaml"), "packages: ['.']\n");
    selectSmokePackageManager(directory, manager);
    const calls = join(directory, "calls.jsonl");
    const bin = join(directory, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "appkit"),
      `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2))+'\\n');\n`,
      { mode: 0o755 },
    );
    execFileSync(manager, ["run", "build"], {
      cwd: directory,
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` },
      stdio: "pipe",
      timeout: 30_000,
    });
    expect(
      readFileSync(calls, "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([
      ["plugin", "sync", "--write", "--silent"],
      ["generate-types", "--wait"],
    ]);
  },
  35_000,
);

test.each([true, false])(
  "prepared locks use the bundled SDKs (local Lakebase: %s)",
  (withLakebase) => {
    const directory = scratch();
    const template = join(directory, "template");
    const tarballs = join(directory, "tarballs");
    mkdirSync(template);
    mkdirSync(tarballs);
    writeFileSync(
      join(template, "package.json"),
      JSON.stringify({
        private: true,
        packageManager: "pnpm@11.0.8",
        dependencies: {
          "@databricks/appkit": "0.0.0",
          "@databricks/appkit-ui": "0.0.0",
        },
        overrides: {},
      }),
    );
    writeFileSync(
      join(template, "pnpm-workspace.yaml"),
      "packages: ['.']\noverrides: {}\n",
    );
    for (const name of [
      "appkit",
      "appkit-ui",
      ...(withLakebase ? ["lakebase"] : []),
    ]) {
      const source = join(directory, name);
      mkdirSync(source);
      writeFileSync(
        join(source, "package.json"),
        JSON.stringify({
          name: `@databricks/${name}`,
          version: "0.0.0",
          dependencies:
            name === "appkit" && withLakebase
              ? { "@databricks/lakebase": "0.0.0" }
              : {},
        }),
      );
      execFileSync(
        "npm",
        ["pack", "--ignore-scripts", "--pack-destination", tarballs],
        { cwd: source, stdio: "pipe", timeout: 30_000 },
      );
    }
    execFileSync(
      process.execPath,
      [
        "--import",
        join(root, "node_modules/tsx/dist/loader.mjs"),
        join(root, "tools/prepare-template-artifact.ts"),
        "--tarball-dir",
        "tarballs",
      ],
      { cwd: directory, stdio: "pipe", timeout: 30_000 },
    );
    const artifact = join(directory, "pr-template");
    execFileSync(
      "npm",
      [
        "install",
        "--package-lock-only",
        "--ignore-scripts",
        "--offline",
        "--no-audit",
        "--no-fund",
      ],
      { cwd: artifact, stdio: "pipe", timeout: 30_000 },
    );
    execFileSync(
      "pnpm",
      [
        "install",
        "--lockfile-only",
        "--no-frozen-lockfile",
        "--ignore-scripts",
        "--offline",
      ],
      { cwd: artifact, stdio: "pipe", timeout: 30_000 },
    );
    checkTemplateArtifact(artifact);
    const workspace = parse(
      readFileSync(join(artifact, "pnpm-workspace.yaml"), "utf-8"),
    );
    expect(workspace.overrides["@databricks/lakebase"]).toBe(
      withLakebase ? "file:./databricks-lakebase-0.0.0.tgz" : undefined,
    );
    expect(existsSync(join(artifact, "databricks-lakebase-0.0.0.tgz"))).toBe(
      withLakebase,
    );
    if (withLakebase) {
      const lockPath = join(artifact, "pnpm-lock.yaml");
      writeFileSync(
        lockPath,
        readFileSync(lockPath, "utf-8").replaceAll(
          "tarball: file:databricks-lakebase-0.0.0.tgz",
          "tarball: file:wrong-lakebase.tgz",
        ),
      );
      expect(() => checkTemplateArtifact(artifact)).toThrow(/wrong.*lakebase/i);
    }
  },
  60_000,
);
