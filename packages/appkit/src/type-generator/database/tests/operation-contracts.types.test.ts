import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import ts from "typescript";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { generateDatabaseTypes } from "../generate";
import { generateDatabaseOperations } from "../generate-operations";

const appkitRoot = path.resolve(import.meta.dirname, "../../../..");
const sourceRoot = path.join(appkitRoot, "src");
const sharedRoot = path.resolve(appkitRoot, "../shared/src");
const builder = path.join(sourceRoot, "database/schema-builder/index");
const operationsModule = path.join(sourceRoot, "plugins/database/operations");
const require = createRequire(import.meta.url);
const zodPackage = path.dirname(require.resolve("zod/package.json"));
const nodeTypes = path.dirname(
  path.dirname(require.resolve("@types/node/package.json")),
);

// String, number, and bigint keys; private, nullable, defaulted, and stamped
// columns; a keyless table; and a table whose public update facet is empty.
const schemaSource = `
import { bigid, bigint, defineSchema, enumColumn, fk, id, integer, jsonb, text, timestamp, varchar } from ${JSON.stringify(builder)};
export const schema = defineSchema(({ table }) => {
  const users = table("users", {
    slug: text().primaryKey(),
    name: varchar(80).notNull(),
    secret: text().private().notNull(),
    nickname: text().default("anonymous"),
    created_at: timestamp().defaultNow().notNull(),
  });
  const posts = table("posts", {
    id: id(),
    user_slug: fk(() => users.slug).notNull(),
    title: text().notNull(),
    score: integer(),
    total: bigint().notNull(),
    status: enumColumn("post_status", ["draft", "live"]).notNull(),
    payload: jsonb(),
  });
  const ledger = table("ledger", { seq: bigid(), note: text().notNull(), amount: bigint() });
  const events = table("events", { message: text().notNull() });
  const stamps = table("stamps", { id: id(), at: timestamp().defaultNow().notNull() });
  return { users, posts, ledger, events, stamps };
});
`;

const header = `
import { z } from "zod";
import { defineOperation, definePolicy, type PolicyContext } from ${JSON.stringify(operationsModule)};
`;

const rows = `${header}
const wireBigint = z.union([z.string(), z.number()]).transform(BigInt);
const post = z.object({ id: z.number(), user_slug: z.string(), title: z.string(), score: z.number().nullable(), status: z.enum(["draft", "live"]) });
const user = z.object({ slug: z.string(), name: z.string(), nickname: z.string().nullable(), created_at: z.string() });
const entry = z.object({ note: z.string() });
export const getPost = defineOperation({ name: "posts.get", method: "GET", input: z.object({ id: z.number() }), output: post, authorize: () => true, execute: ({ input, db }) => db.posts.find(input.id) });
export const getUser = defineOperation({ name: "users.get", method: "GET", input: z.object({ id: z.string() }), output: user, authorize: () => true, execute: ({ input, db }) => db.users.find(input.id) });
export const getEntry = defineOperation({ name: "ledger.get", method: "GET", input: z.object({ id: wireBigint }), output: entry, authorize: () => true, execute: ({ input, db }) => db.ledger.find(input.id) });
export const createUser = defineOperation({ name: "users.create", method: "POST", input: z.object({ slug: z.string(), name: z.string() }), output: user, authorize: () => true, execute: ({ input, db, actor }) => db.users.create({ ...input, secret: actor.id }) });
export const createPost = defineOperation({ name: "posts.create", method: "POST", input: z.object({ user_slug: z.string(), title: z.string(), total: wireBigint, status: z.enum(["draft", "live"]) }), output: post, authorize: () => true, execute: ({ input, db }) => db.posts.create(input) });
export const logEvent = defineOperation({ name: "events.log", method: "POST", input: z.object({ message: z.string() }), authorize: () => true, execute: async ({ input, db }) => { await db.events.create(input); } });
export const stamp = defineOperation({ name: "stamps.create", method: "POST", authorize: () => true, execute: async ({ db }) => { await db.stamps.create({}); } });
export const patchPost = defineOperation({ name: "posts.patch", method: "PATCH", input: z.object({ id: z.number(), changes: z.object({ title: z.string().optional(), total: wireBigint.optional() }) }), output: post, authorize: () => true, execute: ({ input, db }) => db.posts.update(input.id, input.changes) });
export const patchEntry = defineOperation({ name: "ledger.patch", method: "PATCH", input: z.object({ id: wireBigint, changes: z.object({ note: z.string().optional(), amount: wireBigint.nullable().optional() }) }), output: entry, authorize: () => true, execute: ({ input, db }) => db.ledger.update(input.id, input.changes) });
export const replaceUser = defineOperation({ name: "users.replace", method: "PUT", input: z.object({ id: z.string(), values: z.object({ name: z.string(), nickname: z.string().nullable() }) }), authorize: () => true, execute: async ({ input, db }) => { if ((await db.users.update(input.id, input.values)) === null) return null; } });
export const replacePost = defineOperation({ name: "posts.replace", method: "PUT", input: z.object({ id: z.number(), values: z.object({ title: z.string() }) }), output: post, authorize: () => true, execute: ({ input, db }) => db.posts.update(input.id, input.values) });
export const deletePost = defineOperation({ name: "posts.delete", method: "DELETE", input: z.object({ id: z.number() }), authorize: () => true, execute: async ({ input, db }) => { await db.posts.delete(input.id); } });
export const deleteUser = defineOperation({ name: "users.delete", method: "DELETE", input: z.object({ id: z.string() }), authorize: () => true, execute: async ({ input, db }) => { await db.users.delete(input.id); } });
const ownPost = definePolicy({
  resource: ({ input, db }: PolicyContext<{ id: number }>) => db.posts.find(input.id),
  allow: ({ resource, actor }) => resource.user_slug === actor.id,
});
export const readOwnPost = defineOperation({ name: "posts.readOwn", method: "GET", input: z.object({ id: z.number() }), output: post, authorize: ownPost, execute: ({ resource }) => resource });
`;

/** Every construct the Zod renderer supports, on both sides of the wire. */
const custom = `${header}
const Slug = z.string().min(1).meta({ id: "AppKitOperationFixtureSlug" });
export const search = defineOperation({
  name: "posts.search",
  method: "GET",
  input: z.object({
    q: z.string().min(1),
    tags: z.array(z.enum(["a", "b"])).optional(),
    limit: z.int().default(10),
    page: z.number().prefault(1),
    mode: z.union([z.literal("fast"), z.literal(2), z.literal(true), z.null()]),
    cursor: z.string().nullish(),
    later: z.string().optional().nullable(),
    flags: z.array(z.union([z.string(), z.null()])),
    owner: Slug,
    reviewer: Slug.optional(),
    strict: z.strictObject({ exact: z.boolean() }),
    lazy: z.lazy(() => z.object({ leaf: z.string() })),
    required: z.string().optional().nonoptional(),
    trimmed: z.string().transform((value) => value.trim()),
    choice: z.enum({ Low: "low", High: "high" }),
    level: z.enum({ One: 1, Two: 2 }),
    exact: z.literal(["x", 0, false]),
    empty: z.object({}),
    email: z.email(),
  }),
  output: z.object({
    items: z.array(z.object({ id: z.number(), title: z.string().nullable() })).readonly(),
    next: z.string().nullable(),
    total: z.number().default(0),
    filters: z.object({ a: z.string() }).readonly(),
    switch: z.stringbool(),
    piped: z.string().pipe(z.string().min(1)),
  }),
  authorize: () => true,
  execute: () => ({ items: [], next: null, filters: { a: "a" }, switch: "yes", piped: "p" }),
});
export const publish = defineOperation({
  name: "posts.publish",
  method: "POST",
  input: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("now") }),
    z.object({ kind: z.literal("later"), at: z.iso.datetime() }),
  ]),
  output: z.xor([z.object({ id: z.number() }), z.object({ queued: z.literal(true) })]),
  authorize: () => true,
  // Zod output types give TypeScript no literal context, so a literal needs as const.
  execute: () => ({ queued: true as const }),
});
export const inspect = defineOperation({
  name: "posts.inspect",
  method: "PATCH",
  input: z.object({
    id: z.number(),
    payload: z.unknown(),
    tags: z.record(z.string(), z.array(z.string())),
    // Metadata cannot restate a type; the definition decides it.
    label: z.string().meta({ type: "number", readOnly: true }),
  }),
  output: z.object({
    payloads: z.array(z.unknown()),
    counts: z.record(z.string(), z.number()).readonly(),
    nested: z.record(z.string(), z.object({ at: z.string() })),
  }),
  authorize: () => true,
  execute: () => ({ payloads: [], counts: {}, nested: {} }),
});
export const maybePost = defineOperation({
  name: "posts.maybe",
  method: "GET",
  output: z.object({ id: z.number() }).nullable(),
  authorize: () => true,
  execute: () => null,
});
export const archive = defineOperation({
  name: "posts.archive",
  method: "DELETE",
  output: z.object({ archived: z.boolean() }),
  authorize: () => true,
  execute: () => ({ archived: true }),
});
export const resetStamp = defineOperation({
  name: "stamps.reset",
  method: "PUT",
  input: z.object({ id: z.number(), at: z.iso.datetime() }),
  authorize: () => true,
  execute: () => null,
});
export const resetWithoutInput = defineOperation({ name: "stamps.noInput", method: "PUT", authorize: () => true, execute: () => null });
export const touch = defineOperation({
  name: "events.touch",
  method: "PATCH",
  output: z.object({ touched: z.number() }).readonly(),
  authorize: () => true,
  execute: () => ({ touched: 1 }),
});
`;

const operations: Record<string, string> = {
  "posts.get": "getPost",
  "users.get": "getUser",
  "ledger.get": "getEntry",
  "users.create": "createUser",
  "posts.create": "createPost",
  "events.log": "logEvent",
  "stamps.create": "stamp",
  "posts.patch": "patchPost",
  "ledger.patch": "patchEntry",
  "users.replace": "replaceUser",
  "posts.replace": "replacePost",
  "posts.delete": "deletePost",
  "users.delete": "deleteUser",
  "posts.readOwn": "readOwnPost",
  "posts.search": "search",
  "posts.publish": "publish",
  "posts.inspect": "inspect",
  "posts.maybe": "maybePost",
  "posts.archive": "archive",
  "stamps.reset": "resetStamp",
  "events.touch": "touch",
  "stamps.noInput": "resetWithoutInput",
};

/** The generated entry of every operation equals the server's own wire types. */
const consumer = `
import type { OperationWireInput, OperationWireOutput } from "@databricks/appkit/beta";
import * as rows from "./server/database/routes/rows";
import * as custom from "./server/database/routes/custom";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type Operations = DatabricksAppKitDatabaseOperations;
const server = { ...rows, ...custom };

export type Names = Expect<Equal<keyof Operations, ${Object.keys(operations)
  .map((name) => JSON.stringify(name))
  .join(" | ")}>>;
// One line per operation and facet, so a mismatch names its operation.
${Object.entries(operations)
  .flatMap(([name, exportName]) => [
    `export type Method_${exportName} = Expect<Equal<Operations[${JSON.stringify(name)}]["method"], (typeof server.${exportName})["method"]>>;`,
    `export type Input_${exportName} = Expect<Equal<Operations[${JSON.stringify(name)}]["input"], OperationWireInput<typeof server.${exportName}>>>;`,
    `export type Output_${exportName} = Expect<Equal<Operations[${JSON.stringify(name)}]["output"], OperationWireOutput<typeof server.${exportName}>>>;`,
  ])
  .join("\n")}

// The harness distinguishes near misses: a bigint key, a nullable column, and a body.
// @ts-expect-error JSON carries a bigint key as a string or safe integer
export type BigKey = Expect<Equal<Operations["ledger.get"]["input"], { id: string }>>;
// @ts-expect-error a nullable column keeps null
export type Nullable = Expect<Equal<Operations["posts.get"]["output"]["score"], number>>;
// @ts-expect-error an operation without an output answers no body
export type Body = Expect<Equal<Operations["posts.delete"]["output"], undefined>>;
`;

let root = "";

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "appkit-operation-types-"));
  const files: Record<string, string> = {
    "config/database/schema.ts": schemaSource,
    "server/database/routes/rows.ts": rows,
    "server/database/routes/custom.ts": custom,
    "consumer.ts": consumer,
  };
  await fs.mkdir(path.join(root, "node_modules"));
  await fs.symlink(zodPackage, path.join(root, "node_modules", "zod"), "dir");
  for (const [file, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), content);
  }
  await generateDatabaseTypes({
    schemaFile: path.join(root, "config/database/schema.ts"),
    outFile: path.join(root, "shared/appkit-types/database.d.ts"),
  });
  await generateDatabaseOperations({
    appRoot: root,
    outFile: path.join(root, "shared/appkit-types/database-operations.d.ts"),
    strict: true,
  });
}, 30_000);

afterAll(() => fs.rm(root, { recursive: true, force: true }));

/** Every diagnostic of a program over `files`, as `file:line TScode message`. */
function diagnose(
  files: readonly string[],
  compilerOptions: Record<string, unknown>,
): string[] {
  const { options, errors } = ts.parseJsonConfigFileContent(
    { compilerOptions },
    ts.sys,
    root,
  );
  expect(errors).toEqual([]);
  const program = ts.createProgram(
    files.map((file) => path.join(root, file)),
    options,
  );
  return ts.getPreEmitDiagnostics(program).map((diagnostic) => {
    const file = diagnostic.file
      ? path.relative(root, diagnostic.file.fileName)
      : "";
    const line = diagnostic.file
      ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0)
          .line + 1
      : 0;
    return `${file}:${line} TS${diagnostic.code} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`;
  });
}

const strict = {
  strict: true,
  noEmit: true,
  target: "ES2022",
  module: "ESNext",
  moduleResolution: "Bundler",
  lib: ["ES2022"],
};

describe("generated operation contracts", () => {
  test("equal the server's OperationWireInput and OperationWireOutput for every operation", () => {
    expect(
      diagnose(
        [
          "shared/appkit-types/database.d.ts",
          "shared/appkit-types/database-operations.d.ts",
          "server/database/routes.gen.ts",
          "consumer.ts",
        ],
        {
          ...strict,
          esModuleInterop: true,
          resolveJsonModule: true,
          skipLibCheck: true,
          types: ["node"],
          typeRoots: [nodeTypes],
          baseUrl: root,
          paths: {
            "@databricks/appkit": [path.join(sourceRoot, "index.ts")],
            "@databricks/appkit/beta": [path.join(sourceRoot, "beta.ts")],
            shared: [path.join(sharedRoot, "index.ts")],
            "shared/*": [path.join(sharedRoot, "*")],
            "@databricks/lakebase": [
              path.resolve(appkitRoot, "../lakebase/src/index.ts"),
            ],
            zod: [zodPackage],
          },
        },
      ),
    ).toEqual([]);
  }, 120_000);

  test("compile alone in a browser program, without imports or Node types", async () => {
    const declaration = await fs.readFile(
      path.join(root, "shared/appkit-types/database-operations.d.ts"),
      "utf8",
    );
    expect(declaration).not.toMatch(/^\s*(?:import|export\s+\*|\/\/\/)/m);
    expect(declaration).not.toMatch(/\bany\b/);
    expect(
      diagnose(["shared/appkit-types/database-operations.d.ts"], {
        ...strict,
        lib: ["ES2022", "DOM"],
        types: [],
        skipLibCheck: false,
        noResolve: true,
      }),
    ).toEqual([]);
  }, 30_000);
});
