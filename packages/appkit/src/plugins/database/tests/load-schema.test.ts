import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { loadDefaultDatabaseSchema } from "../load-schema";

const roots: string[] = [];
const builder = path.resolve(
  import.meta.dirname,
  "../../../database/schema-builder/index.ts",
);
const source = `
  import { defineSchema, id, text } from ${JSON.stringify(builder)};
  const tableName: string = "notes";
  export const schema = defineSchema(({ table }) => ({
    notes: table(tableName, { id: id(), body: text().notNull(), secret: text().private() }),
  }));
`;

async function fixture(contents?: string) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "appkit-default-schema-"),
  );
  roots.push(root);
  const file = path.join(root, "config/database/schema.ts");
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (contents !== undefined) await fs.writeFile(file, contents);
  return { root, file };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("default database schema", () => {
  test("loads the named TypeScript schema from the application convention", async () => {
    const { root } = await fixture(source);
    const schema = await loadDefaultDatabaseSchema(root);
    expect(Object.keys(schema.$tables)).toEqual(["notes"]);
    expect(schema.$tables.notes.$columns.secret.isPrivate).toBe(true);
    expect(schema.$tables.notes.$columns.body.notNull).toBe(true);
    expect(Object.isFrozen(schema)).toBe(true);
  });

  test("uses the application's working directory when no root is passed", async () => {
    const { root } = await fixture(source);
    vi.spyOn(process, "cwd").mockReturnValue(root);
    expect(Object.keys((await loadDefaultDatabaseSchema()).$tables)).toEqual([
      "notes",
    ]);
  });

  test("accepts an intentionally empty declaration without inventing tables", async () => {
    const { root } = await fixture(`
      import { defineSchema } from ${JSON.stringify(builder)};
      export const schema = defineSchema(() => ({}));
    `);
    expect((await loadDefaultDatabaseSchema(root)).$tables).toEqual({});
  });

  test("explains the convention and explicit override when the file is missing", async () => {
    const { root } = await fixture();
    await expect(loadDefaultDatabaseSchema(root)).rejects.toMatchObject({
      category: "SETUP_FAILED",
      phase: "setup",
      message: expect.stringContaining("config/database/schema.ts"),
      clientMessage: "Database setup failed",
      cause: undefined,
    });
    await expect(loadDefaultDatabaseSchema(root)).rejects.toThrow(
      "database({ schema })",
    );
  });

  test("rejects a directory instead of searching it for another module", async () => {
    const { root, file } = await fixture();
    await fs.mkdir(file);
    await expect(loadDefaultDatabaseSchema(root)).rejects.toThrow(
      "must be a file",
    );
  });

  test.each([
    [
      "default export",
      source.replace("export const schema =", "export default"),
    ],
    [
      "alternate export",
      source.replace("export const schema =", "export const otherSchema ="),
    ],
  ])(
    "requires the named schema rather than accepting a %s",
    async (_name, contents) => {
      const { root } = await fixture(contents);
      await expect(loadDefaultDatabaseSchema(root)).rejects.toMatchObject({
        category: "SETUP_FAILED",
        message: expect.stringContaining('named "schema"'),
        clientMessage: "Database setup failed",
      });
    },
  );

  test.each(["null", "undefined", "{}", "{ $tables: {} }", "42"])(
    "rejects an unfinalized schema export: %s",
    async (value) => {
      const { root } = await fixture(`export const schema = ${value};`);
      await expect(loadDefaultDatabaseSchema(root)).rejects.toMatchObject({
        category: "SETUP_FAILED",
        message: expect.stringContaining("defineSchema()"),
        clientMessage: "Database setup failed",
      });
    },
  );

  test.each([
    'throw new Error("credential secret");',
    "export const schema = ;",
    'import "./missing-dependency"; export const schema = {};',
  ])(
    "keeps schema import failures actionable without leaking their details",
    async (contents) => {
      const { root } = await fixture(contents);
      const error = await loadDefaultDatabaseSchema(root).catch(
        (caught) => caught,
      );
      expect(error).toMatchObject({
        category: "SETUP_FAILED",
        message: expect.stringContaining("Could not load the default schema"),
        clientMessage: "Database setup failed",
        cause: undefined,
        details: undefined,
      });
      expect(error.message).not.toContain("credential secret");
      expect(error.message).not.toContain("missing-dependency");
    },
  );

  test("fresh loads observe edits in the schema's imported declarations", async () => {
    const { root, file } = await fixture(`
      import { defineSchema, text } from ${JSON.stringify(builder)};
      import { field } from "./columns";
      export const schema = defineSchema(({ table }) => ({
        notes: table("notes", { [field]: text() }),
      }));
    `);
    const dependency = path.join(path.dirname(file), "columns.ts");
    await fs.writeFile(dependency, 'export const field = "before";');
    expect(
      (await loadDefaultDatabaseSchema(root)).$tables.notes.$columns,
    ).toHaveProperty("before");
    await fs.writeFile(dependency, 'export const field = "after";');
    expect(
      (await loadDefaultDatabaseSchema(root)).$tables.notes.$columns,
    ).toHaveProperty("after");
  });
});
