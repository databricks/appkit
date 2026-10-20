import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

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
async function failingImport(error: { message: string; code: string }) {
  vi.resetModules();
  vi.doMock("drizzle-kit/api", () => {
    throw Object.assign(new Error(error.message), { code: error.code });
  });
  return import("../migrations");
}

function withoutPackage(name: string) {
  return failingImport({
    message: `Cannot find package '${name}' imported from /app/node_modules/@databricks/appkit/dist/database/tooling/migrations.js`,
    code: "ERR_MODULE_NOT_FOUND",
  });
}

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "appkit-drizzle-kit-"));
  folders.push(root);
  return root;
}

function generate(migrations: typeof import("../migrations")) {
  return migrations.generateMigrationFiles({
    folder: path.join(tempRoot(), "migrations"),
    schema: defineSchema(({ table }) => ({
      notes: table("notes", { id: id() }),
    })),
    interactive: false,
  });
}

/** A file URL in an app whose node_modules holds these drizzle-kit and drizzle-orm versions. */
function appWith(versions: { kit?: string; orm?: string }): string {
  const root = tempRoot();
  for (const [name, version] of [
    ["drizzle-kit", versions.kit],
    ["drizzle-orm", versions.orm],
  ] as const) {
    if (!version) continue;
    const dir = path.join(root, "node_modules", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name, version, main: "index.js" }),
    );
    fs.writeFileSync(path.join(dir, "index.js"), "");
  }
  return pathToFileURL(path.join(root, "app.js")).href;
}

const pkg = JSON.parse(
  fs.readFileSync(path.resolve(SRC, "../package.json"), "utf-8"),
);
const ORM_VERSION: string = pkg.dependencies["drizzle-orm"];

describe("drizzle-kit dependency", () => {
  test("without drizzle-kit, generating says how to install it", async () => {
    const migrations = await withoutPackage("drizzle-kit");

    await expect(generate(migrations)).rejects.toThrow(
      `Generating migrations needs drizzle-kit, which is not installed. Add it as a dev dependency: npm install --save-dev drizzle-kit@${migrations.DRIZZLE_KIT_VERSION}`,
    );
  });

  test("a drizzle-kit without the ./api export gets the same install hint", async () => {
    const migrations = await failingImport({
      message: `Package subpath './api' is not defined by "exports" in /app/node_modules/drizzle-kit/package.json`,
      code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
    });

    await expect(generate(migrations)).rejects.toThrow(
      `npm install --save-dev drizzle-kit@${migrations.DRIZZLE_KIT_VERSION}`,
    );
  });

  test("the pinned drizzle-kit on AppKit's drizzle-orm may write migrations", async () => {
    const { DRIZZLE_KIT_VERSION, drizzleKitMismatch } =
      await import("../migrations");

    expect(
      drizzleKitMismatch(
        appWith({ kit: DRIZZLE_KIT_VERSION, orm: ORM_VERSION }),
      ),
    ).toBeUndefined();
    expect(drizzleKitMismatch(appWith({}))).toBeUndefined();
  });

  test("another drizzle-kit version is refused with the command that installs the pinned one", async () => {
    const { DRIZZLE_KIT_VERSION, drizzleKitMismatch } =
      await import("../migrations");

    expect(
      drizzleKitMismatch(appWith({ kit: "0.30.6", orm: ORM_VERSION })),
    ).toBe(
      `AppKit writes migrations with drizzle-kit ${DRIZZLE_KIT_VERSION}, but 0.30.6 is installed. Install that version: npm install --save-dev drizzle-kit@${DRIZZLE_KIT_VERSION}`,
    );
  });

  test("a drizzle-kit that loads another drizzle-orm is refused", async () => {
    const { DRIZZLE_KIT_VERSION, drizzleKitMismatch } =
      await import("../migrations");

    expect(
      drizzleKitMismatch(appWith({ kit: DRIZZLE_KIT_VERSION, orm: "0.44.0" })),
    ).toBe(
      `drizzle-kit loads drizzle-orm 0.44.0, but AppKit builds schemas with ${ORM_VERSION}. Use the same version: npm install drizzle-orm@${ORM_VERSION}`,
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

    expect(pkg.dependencies["drizzle-kit"]).toBeUndefined();
    expect(pkg.peerDependencies["drizzle-kit"]).toBe(DRIZZLE_KIT_VERSION);
    expect(pkg.peerDependenciesMeta["drizzle-kit"]).toEqual({ optional: true });
    expect(pkg.devDependencies["drizzle-kit"]).toBe(DRIZZLE_KIT_VERSION);
  });
});
