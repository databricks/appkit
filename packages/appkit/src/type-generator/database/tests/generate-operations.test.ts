import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { validateOperationMetadata } from "../../../plugins/database/operation-metadata";
import type {
  DatabaseRoutes,
  LocatedDeclaration,
} from "../../../plugins/database/operations";
import {
  generateDatabaseOperations,
  NEUTRAL_DATABASE_OPERATION_TYPES,
} from "../generate-operations";

const appkitRoot = path.resolve(import.meta.dirname, "../../../..");
const sourceRoot = path.join(appkitRoot, "src");
const builder = path.join(sourceRoot, "database/schema-builder/index");
const operationsModule = path.join(sourceRoot, "plugins/database/operations");
const zodPackage = path.dirname(
  createRequire(import.meta.url).resolve("zod/package.json"),
);

const ROUTES = "server/database/routes";
const ROUTES_FILE = "server/database/routes.gen.ts";
const TYPES_FILE = "shared/appkit-types/database-operations.d.ts";

const schemaSource = `
  import { bigint, defineSchema, id, integer, text, timestamp } from ${JSON.stringify(builder)};
  export const schema = defineSchema(({ table }) => ({
    notes: table("notes", { id: id(), body: text().notNull(), rank: integer() }),
    boards: table("boards", { slug: text().primaryKey(), title: text().notNull(), total: bigint() }),
    events: table("events", { message: text().notNull() }),
    stamps: table("stamps", { id: id(), at: timestamp().defaultNow().notNull() }),
  }));
`;

/** A route module importing the real operation API, as an app's would. */
const route = (body: string) => `
import { z } from "zod";
import { defineOperation } from ${JSON.stringify(operationsModule)};
void z;
${body}
`;

const getNote = `export const getNote = defineOperation({
  name: "notes.get",
  entity: "notes",
  method: "GET",
  authorize: () => true,
  execute: ({ input, db }) => db.notes.find(input.id),
});`;

const getBoard = (
  exportName = "getBoard",
) => `export const ${exportName} = defineOperation({
  name: "boards.get",
  entity: "boards",
  method: "GET",
  authorize: () => true,
  execute: ({ input, db }) => db.boards.find(input.id),
});`;

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function write(root: string, file: string, content: string) {
  const target = path.join(root, file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}

/** A temporary app with a schema, `zod` installed, and the given files. */
async function app(files: Record<string, string> = {}): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "appkit-database-operations-"),
  );
  roots.push(root);
  await fs.mkdir(path.join(root, "node_modules"));
  await fs.symlink(zodPackage, path.join(root, "node_modules", "zod"), "dir");
  await write(root, "config/database/schema.ts", schemaSource);
  for (const [file, content] of Object.entries(files)) {
    await write(root, file, content);
  }
  return root;
}

function generate(root: string, strict = false) {
  return generateDatabaseOperations({
    appRoot: root,
    outFile: path.join(root, TYPES_FILE),
    strict,
  });
}

const read = (root: string, file: string) =>
  fs.readFile(path.join(root, file), "utf8");

const exists = (root: string, file: string) =>
  fs.access(path.join(root, file)).then(
    () => true,
    () => false,
  );

async function failure(promise: Promise<void>): Promise<Error> {
  const error: unknown = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof Error)) throw new Error("generation did not fail");
  expect(error.name).toBe("DatabaseTypegenError");
  return error;
}

/** Every export of every listed module, loaded through the generated entry. */
async function loadGenerated(root: string) {
  const { databaseRoutes }: { databaseRoutes: DatabaseRoutes } = await import(
    path.join(root, ROUTES_FILE)
  );
  const { schema } = await databaseRoutes.schema();
  const located: LocatedDeclaration[] = [];
  for (const module of databaseRoutes.modules) {
    const namespace = await module.load();
    for (const [exportName, value] of Object.entries(namespace)) {
      located.push({ file: module.file, exportName, value });
    }
  }
  return validateOperationMetadata(
    located,
    new Set(Object.keys(schema.$tables)),
  );
}

describe("generateDatabaseOperations", () => {
  test("lists direct route modules in path order, lazily, behind one type import", async () => {
    const root = await app({
      [`${ROUTES}/notes.ts`]: route(getNote),
      [`${ROUTES}/boards.ts`]: route(getBoard()),
      [`${ROUTES}/boards.test.ts`]: "throw new Error('a test is not a route');",
      [`${ROUTES}/shapes.d.ts`]: "export {};",
      [`${ROUTES}/table.gen.ts`]: "throw new Error('generated');",
      [`${ROUTES}/nested/deep.ts`]: "throw new Error('not recursive');",
      [`${ROUTES}/README.md`]: "notes",
    });

    await generate(root);

    expect(await read(root, ROUTES_FILE))
      .toBe(`// Auto-generated by AppKit - DO NOT EDIT
import type { DatabaseRoutes } from "@databricks/appkit/beta";

export const databaseRoutes = {
  schema: () => import("../../config/database/schema"),
  modules: [
    {
      file: "server/database/routes/boards.ts",
      load: () => import("./routes/boards"),
    },
    {
      file: "server/database/routes/notes.ts",
      load: () => import("./routes/notes"),
    },
  ],
} satisfies DatabaseRoutes;
`);
    const types = await read(root, TYPES_FILE);
    expect(types).toContain('"boards.get": {');
    expect(types).toContain('"notes.get": {');
    expect(types).not.toMatch(/^\s*import\b/m);
  });

  test("creates nothing for an app without operation routes", async () => {
    const root = await app();
    await generate(root);
    expect(await exists(root, ROUTES_FILE)).toBe(false);
    expect(await exists(root, TYPES_FILE)).toBe(false);
  });

  test("regenerates both files deterministically as modules are added, renamed, and removed", async () => {
    const root = await app({ [`${ROUTES}/notes.ts`]: route(getNote) });
    await generate(root);
    const notesOnly = {
      routes: await read(root, ROUTES_FILE),
      types: await read(root, TYPES_FILE),
    };
    expect(notesOnly.types).toContain('"notes.get": {');

    await write(root, `${ROUTES}/boards.ts`, route(getBoard()));
    await generate(root);
    const withBoards = {
      routes: await read(root, ROUTES_FILE),
      types: await read(root, TYPES_FILE),
    };
    expect(withBoards.routes).toContain('import("./routes/boards")');
    expect(withBoards.types).toContain('"boards.get": {');

    // A name, not a path or export identifier, keys the browser contract.
    await fs.rename(
      path.join(root, ROUTES, "boards.ts"),
      path.join(root, ROUTES, "panels.ts"),
    );
    await generate(root);
    expect(await read(root, ROUTES_FILE)).toContain(
      'load: () => import("./routes/panels")',
    );
    expect(await read(root, ROUTES_FILE)).not.toContain("boards");
    expect(await read(root, TYPES_FILE)).toBe(withBoards.types);

    await write(root, `${ROUTES}/panels.ts`, route(getBoard("readPanel")));
    await generate(root);
    expect(await read(root, TYPES_FILE)).toBe(withBoards.types);

    await fs.rm(path.join(root, ROUTES, "panels.ts"));
    await generate(root);
    expect(await read(root, ROUTES_FILE)).toBe(notesOnly.routes);
    expect(await read(root, TYPES_FILE)).toBe(notesOnly.types);

    const before = (await fs.stat(path.join(root, ROUTES_FILE))).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await generate(root);
    expect((await fs.stat(path.join(root, ROUTES_FILE))).mtimeMs).toBe(before);

    await fs.rm(path.join(root, ROUTES), { recursive: true });
    await generate(root);
    expect(await read(root, ROUTES_FILE)).toContain("  modules: [],\n");
    expect(await read(root, TYPES_FILE)).toBe(NEUTRAL_DATABASE_OPERATION_TYPES);
  });

  test("deleting authorize drops the operation and the runtime validator skips it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = await app({ [`${ROUTES}/notes.ts`]: route(getNote) });
    await generate(root);
    expect(await read(root, TYPES_FILE)).toContain('"notes.get": {');

    await write(
      root,
      `${ROUTES}/notes.ts`,
      route(getNote.replace("  authorize: () => true,\n", "")),
    );
    await generate(root);

    expect(await read(root, TYPES_FILE)).toBe(NEUTRAL_DATABASE_OPERATION_TYPES);
    expect(await read(root, ROUTES_FILE)).toContain('import("./routes/notes")');
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      "server/database/routes/notes.ts#getNote has no authorization and was skipped.",
    );
    const runtime = await loadGenerated(root);
    expect(runtime.operations).toEqual([]);
    expect(runtime.errors).toEqual([]);
    expect(runtime.skipped).toMatchObject([
      {
        file: "server/database/routes/notes.ts",
        exportName: "getNote",
        code: "authorize",
      },
    ]);
  });

  test("skips an unauthorized declaration in development and fails it in strict mode", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = await app({
      [`${ROUTES}/notes.ts`]: route(
        `${getNote}\nexport const open = defineOperation({ name: "notes.open", entity: "notes", method: "GET", execute: () => null });`,
      ),
    });

    await generate(root);
    const development = await read(root, TYPES_FILE);
    expect(development).toContain('"notes.get": {');
    expect(development).not.toContain("notes.open");

    const error = await failure(generate(root, true));
    expect(error.message).toContain(
      "server/database/routes/notes.ts#open has no authorization; strict generation requires one.",
    );
    expect(await read(root, TYPES_FILE)).toBe(NEUTRAL_DATABASE_OPERATION_TYPES);
  });

  test("names a module that cannot load without its error text and neutralizes the contracts", async () => {
    const root = await app({ [`${ROUTES}/notes.ts`]: route(getNote) });
    await generate(root);
    expect(await read(root, TYPES_FILE)).toContain('"notes.get": {');

    await write(
      root,
      `${ROUTES}/broken.ts`,
      'throw new Error("SECRET-TOKEN in a row value");',
    );
    await write(
      root,
      `${ROUTES}/orphan.ts`,
      'import { missing } from "./not-there";\nexport const value = missing;',
    );
    const error = await failure(generate(root));

    expect(error.message).toContain(
      "server/database/routes/broken.ts threw while loading.",
    );
    expect(error.message).toContain(
      "server/database/routes/orphan.ts contains an unresolved import.",
    );
    expect(error.message).not.toContain("SECRET-TOKEN");
    expect(error.message).not.toContain("not-there");
    expect(await read(root, TYPES_FILE)).toBe(NEUTRAL_DATABASE_OPERATION_TYPES);
    // The route entry still lists every module; the runtime revalidates them.
    const routes = await read(root, ROUTES_FILE);
    expect(routes).toContain('import("./routes/broken")');
    expect(routes).toContain('import("./routes/orphan")');
  });

  test("fails on duplicate names and malformed declarations", async () => {
    const root = await app({
      [`${ROUTES}/notes.ts`]: route(getNote),
      [`${ROUTES}/copy.ts`]: route(getNote.replace("getNote", "copiedNote")),
      [`${ROUTES}/invalid.ts`]: route(`
export const ghost = defineOperation({ name: "ghosts.get", entity: "ghosts", method: "GET", authorize: () => true, execute: () => null });
export const keyless = defineOperation({ name: "events.get", entity: "events", method: "GET", authorize: () => true, execute: () => null });
export const frozen = defineOperation({ name: "stamps.patch", entity: "stamps", method: "PATCH", authorize: () => true, execute: () => null });
export const headless = defineOperation({ name: "notes.head", entity: "notes", method: "HEAD", authorize: () => true, execute: () => null });
`),
    });
    const error = await failure(generate(root));

    expect(error.message).toContain(
      'server/database/routes/notes.ts#getNote repeats operation name "notes.get", already exported by server/database/routes/copy.ts#copiedNote.',
    );
    expect(error.message).toContain(
      "server/database/routes/invalid.ts#ghost must name one entity in the database schema.",
    );
    expect(error.message).toContain(
      "server/database/routes/invalid.ts#headless must use GET, POST, PATCH, PUT, or DELETE.",
    );
    expect(error.message).toContain(
      'server/database/routes/invalid.ts#keyless input needs an explicit schema: "events" has no default GET input.',
    );
    expect(error.message).toContain(
      'server/database/routes/invalid.ts#frozen input needs an explicit schema: "stamps" has no default PATCH input.',
    );
    expect(await read(root, TYPES_FILE)).toBe(NEUTRAL_DATABASE_OPERATION_TYPES);
  });

  test("requires the schema the routes are declared against", async () => {
    const root = await app({ [`${ROUTES}/notes.ts`]: route(getNote) });
    await fs.rm(path.join(root, "config"), { recursive: true });
    const error = await failure(generate(root));
    expect(error.message).toContain(
      "server/database/routes needs a schema at config/database/schema.ts.",
    );
    expect(await read(root, TYPES_FILE)).toBe(NEUTRAL_DATABASE_OPERATION_TYPES);
  });

  test("names the source and slot of every Zod schema without an exact JSON type", async () => {
    const operation = (name: string, input: string, output = "undefined") =>
      `export const ${name} = defineOperation({ name: "notes.${name}", entity: "notes", method: "POST", input: ${input}, output: ${output}, authorize: () => true, execute: () => null } as never);`;
    const unsupported: Record<string, [string, string, string?]> = {
      big: ["input", "z.object({ n: z.bigint() })"],
      date: ["output", "z.object({})", "z.object({ at: z.date() })"],
      transformed: ["output", "z.object({})", "z.string().transform(Number)"],
      recursive: [
        "input",
        "(() => { const tree = z.object({ name: z.string(), get children() { return z.array(tree); } }); return tree; })()",
      ],
      enumKeys: ["input", 'z.record(z.enum(["a", "b"]), z.number())'],
      checkedKeys: ["input", "z.record(z.string().min(2), z.number())"],
      json: ["input", "z.object({ value: z.json() })"],
      any: ["input", "z.object({ value: z.any() })"],
      coerced: ["input", "z.object({ value: z.coerce.number() })"],
      preprocessed: [
        "input",
        "z.object({ value: z.preprocess((v) => v, z.string()) })",
      ],
      optionalRoot: ["input", "z.object({ a: z.string() }).optional()"],
      optionalItem: ["input", "z.array(z.string().optional())"],
      tuple: ["input", "z.tuple([z.string(), z.number()])"],
      intersection: [
        "input",
        "z.intersection(z.object({ a: z.string() }), z.object({ b: z.string() }))",
      ],
      catchall: ["input", "z.object({ a: z.string() }).catchall(z.number())"],
      caught: ["input", 'z.object({ a: z.string().catch("x") })'],
      template: [
        "input",
        'z.object({ a: z.templateLiteral(["n", z.number()]) })',
      ],
      leaky: ["input", 'z.lazy(() => { throw new Error("SECRET-TOKEN"); })'],
    };
    const root = await app({
      [`${ROUTES}/zod.ts`]: route(
        Object.entries(unsupported)
          .map(([name, [, input, output]]) => operation(name, input, output))
          .join("\n"),
      ),
    });

    const error = await failure(generate(root));

    for (const [name, [slot]] of Object.entries(unsupported)) {
      expect(error.message).toContain(
        `server/database/routes/zod.ts#${name} ${slot} `,
      );
    }
    expect(error.message).toContain(
      "#big input has no JSON type (BigInt cannot be represented in JSON Schema).",
    );
    expect(error.message).toContain("#recursive input is recursive.");
    expect(error.message).toContain(
      "#enumKeys input uses a record whose keys are not plain strings.",
    );
    expect(error.message).toContain(
      "#optionalRoot input may be undefined outside an object property.",
    );
    expect(error.message).toContain(
      "#leaky input could not be converted to JSON Schema.",
    );
    expect(error.message).not.toContain("SECRET-TOKEN");
    expect(await read(root, TYPES_FILE)).toBe(NEUTRAL_DATABASE_OPERATION_TYPES);
  });
});
