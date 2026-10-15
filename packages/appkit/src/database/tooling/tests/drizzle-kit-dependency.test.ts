import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { defineSchema, id } from "../../schema-builder";

const SRC = path.resolve(import.meta.dirname, "../../..");
const folders: string[] = [];

afterEach(() => {
  vi.doUnmock("drizzle-kit/api");
  vi.resetModules();
  for (const folder of folders.splice(0)) {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

/** Load ../migrations with `import("drizzle-kit/api")` failing like Node's resolver does. */
async function withoutPackage(name: string) {
  vi.resetModules();
  vi.doMock("drizzle-kit/api", () => {
    throw Object.assign(
      new Error(
        `Cannot find package '${name}' imported from /app/node_modules/@databricks/appkit/dist/database/tooling/migrations.js`,
      ),
      { code: "ERR_MODULE_NOT_FOUND" },
    );
  });
  return import("../migrations");
}

function generate(migrations: typeof import("../migrations")) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "appkit-drizzle-kit-"));
  folders.push(root);
  return migrations.generateMigrationFiles({
    folder: path.join(root, "migrations"),
    schema: defineSchema(({ table }) => ({
      notes: table("notes", { id: id() }),
    })),
    interactive: false,
  });
}

/** Source files outside tests, relative to src/. */
function sourceFiles(): string[] {
  return (fs.readdirSync(SRC, { recursive: true }) as string[]).filter(
    (file) =>
      /\.tsx?$/.test(file) &&
      !/\.test\.tsx?$/.test(file) &&
      !file.split(path.sep).includes("tests"),
  );
}

describe("drizzle-kit dependency", () => {
  test("without drizzle-kit, generating says how to install it", async () => {
    const migrations = await withoutPackage("drizzle-kit");

    await expect(generate(migrations)).rejects.toThrow(
      `Generating migrations needs drizzle-kit, which is not installed. Add it as a dev dependency: npm install --save-dev drizzle-kit@${migrations.DRIZZLE_KIT_VERSION}`,
    );
  });

  test("another missing package is not reported as a missing drizzle-kit", async () => {
    const migrations = await withoutPackage("esbuild");

    const error = (await generate(migrations).catch(
      (caught: unknown) => caught,
    )) as Error;
    expect(error.message).not.toContain("npm install");
  });

  test("it is an optional peer dependency pinned to DRIZZLE_KIT_VERSION, never a dependency", async () => {
    const { DRIZZLE_KIT_VERSION } = await import("../migrations");
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(SRC, "../package.json"), "utf-8"),
    );

    expect(pkg.dependencies["drizzle-kit"]).toBeUndefined();
    expect(pkg.peerDependencies["drizzle-kit"]).toBe(DRIZZLE_KIT_VERSION);
    expect(pkg.peerDependenciesMeta["drizzle-kit"]).toEqual({ optional: true });
    expect(pkg.devDependencies["drizzle-kit"]).toBe(DRIZZLE_KIT_VERSION);
  });

  test("only the tooling imports drizzle-kit, and no runtime module imports the tooling", () => {
    const imports = (file: string, pattern: RegExp) =>
      pattern.test(fs.readFileSync(path.join(SRC, file), "utf-8"));
    const tooling = path.join("database", "tooling");

    expect(
      sourceFiles().filter((file) =>
        imports(file, /(?:from\s+|import\s*\(\s*)["']drizzle-kit/),
      ),
    ).toEqual([path.join(tooling, "migrations.ts")]);
    expect(
      sourceFiles().filter(
        (file) =>
          !file.startsWith(`${tooling}${path.sep}`) &&
          imports(file, /from\s+["'][^"']*\/tooling(?:\/[^"']*)?["']/),
      ),
    ).toEqual([]);
  });
});
