import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import ts from "typescript";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { generateDatabaseTypes } from "../../../type-generator/database/generate";

const appkitRoot = path.resolve(import.meta.dirname, "../../../..");
const sourceRoot = path.join(appkitRoot, "src");
const sharedRoot = path.resolve(appkitRoot, "../shared/src");
const builder = path.join(sourceRoot, "database/schema-builder/index.ts");
const zodRoot = path.dirname(
  createRequire(import.meta.url).resolve("zod/package.json"),
);

// String, number, bigint, and absent keys, a private column, defaults, and a bigint value.
const schemaSource = `
  import { bigid, bigint, defineSchema, fk, id, integer, text, timestamp, varchar } from ${JSON.stringify(builder)};
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
    });
    const ledger = table("ledger", { seq: bigid(), note: text().notNull() });
    const events = table("events", { message: text().notNull() });
    const stamps = table("stamps", { id: id(), at: timestamp().defaultNow().notNull() });
    return { users, posts, ledger, events, stamps };
  });
`;

const positive = `
import type { DatabaseRegistry } from "@databricks/appkit";
import {
  type DatabaseExports,
  defineOperation,
  definePolicy,
  type OperationContext,
  type OperationWireInput,
  type OperationWireOutput,
  type PolicyContext,
} from "@databricks/appkit/beta";
import { z } from "zod";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type IsAny<T> = 0 extends 1 & T ? true : false;
type Same<A, B> = IsAny<A> extends true
  ? false
  : [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type UserRow = DatabaseRegistry["users"]["publicRow"];
type PostRow = DatabaseRegistry["posts"]["publicRow"];

export type Registry = Expect<
  Equal<keyof DatabaseExports, "users" | "posts" | "ledger" | "events" | "stamps" | "sql" | "transaction">
>;

export const getPost = defineOperation({
  name: "posts.get",
  entity: "posts",
  method: "GET",
  authorize: ({ actor }) => actor.id.length > 0,
  execute: ({ input, db, resource, actor, appkit }) => {
    type _Input = Expect<Equal<typeof input, { id: number }>>;
    type _Resource = Expect<Equal<typeof resource, undefined>>;
    type _Actor = Expect<Equal<typeof actor.email, string | undefined>>;
    type _Database = Expect<Equal<typeof appkit.database, typeof db>>;
    type _Plugins = Expect<
      Equal<
        Exclude<keyof typeof appkit, "database">,
        "agents" | "aiSearch" | "analytics" | "files" | "genie" | "jobs" | "lakebase" | "server" | "serving"
      >
    >;
    type _Optional = Expect<Equal<undefined extends typeof appkit.analytics ? true : false, true>>;
    type _Typed = Expect<Equal<IsAny<NonNullable<typeof appkit.analytics>["query"]>, false>>;
    return db.posts.find(input.id);
  },
});
export type GetPost = [
  Expect<Equal<(typeof getPost)["name"], "posts.get">>,
  Expect<Equal<(typeof getPost)["entity"], "posts">>,
  Expect<Equal<(typeof getPost)["method"], "GET">>,
  Expect<Equal<(typeof getPost)["input"], undefined>>,
  Expect<Equal<OperationWireInput<typeof getPost>, { id: number }>>,
  Expect<
    Equal<
      OperationWireOutput<typeof getPost>,
      { id: number; user_slug: string; title: string; score: number | null; total: string }
    >
  >,
];

export const createUser = defineOperation({
  name: "users.create",
  entity: "users",
  method: "POST",
  authorize: async ({ input, actor }) => input.slug === actor.id,
  execute: async ({ input, db, actor }) => {
    type _Input = Expect<
      Equal<typeof input, { slug: string; name: string; nickname?: string | null; created_at?: string }>
    >;
    return db.users.create({ ...input, secret: actor.id });
  },
});
export type CreateUser = [
  Expect<
    Equal<
      OperationWireInput<typeof createUser>,
      { slug: string; name: string; nickname?: string | null; created_at?: string }
    >
  >,
  Expect<Equal<OperationWireOutput<typeof createUser>, UserRow>>,
];

export const logEvent = defineOperation({
  name: "events.log",
  entity: "events",
  method: "POST",
  authorize: () => true,
  execute: ({ input }) => input,
});

export const patchPost = defineOperation({
  name: "posts.patch",
  entity: "posts",
  method: "PATCH",
  authorize: () => true,
  execute: ({ input, db }) => {
    type _Input = Expect<
      Equal<
        typeof input,
        { id: number; changes: { user_slug?: string; title?: string; score?: number | null; total?: bigint } }
      >
    >;
    return db.posts.update(input.id, input.changes);
  },
});
export type PatchPost = Expect<
  Equal<
    OperationWireInput<typeof patchPost>,
    {
      id: number;
      changes: { user_slug?: string; title?: string; score?: number | null; total?: string | number };
    }
  >
>;

export const replaceUser = defineOperation({
  name: "users.replace",
  entity: "users",
  method: "PUT",
  authorize: () => true,
  execute: async ({ input, db }) => {
    type _Input = Expect<
      Equal<typeof input, { id: string; values: { name: string; nickname: string | null } }>
    >;
    return db.users.update(input.id, input.values);
  },
});

export const deletePost = defineOperation({
  name: "posts.delete",
  entity: "posts",
  method: "DELETE",
  authorize: () => true,
  execute: ({ input, db }) => db.posts.delete(input.id),
});
export type DeletePost = [
  Expect<Equal<OperationWireInput<typeof deletePost>, { id: number }>>,
  Expect<Equal<OperationWireOutput<typeof deletePost>, void>>,
];

export const getEntry = defineOperation({
  name: "ledger.get",
  entity: "ledger",
  method: "GET",
  authorize: () => true,
  execute: ({ input, db }) => {
    type _Input = Expect<Equal<typeof input, { id: bigint }>>;
    return db.ledger.find(input.id);
  },
});
export type GetEntry = [
  Expect<Equal<OperationWireInput<typeof getEntry>, { id: string | number }>>,
  Expect<Equal<OperationWireOutput<typeof getEntry>, { seq: string; note: string }>>,
];

export const latestEvent = defineOperation({
  name: "events.latest",
  entity: "events",
  method: "GET",
  input: z.object({ message: z.string() }),
  authorize: () => true,
  execute: ({ input, db }) => db.events.where({ message: input.message }).first(),
});
export type LatestEvent = [
  Expect<Equal<OperationWireInput<typeof latestEvent>, { message: string }>>,
  Expect<Equal<OperationWireOutput<typeof latestEvent>, { message: string }>>,
];

export const draftPost = defineOperation({
  name: "posts.draft",
  entity: "posts",
  method: "POST",
  input: z.object({ title: z.string().trim(), pinned: z.boolean().default(false) }),
  output: z.object({ id: z.number(), total: z.bigint().transform(String) }),
  authorize: ({ input }) => input.title.length > 0,
  execute: async ({ input, db, actor }) => {
    type _Input = Expect<Equal<typeof input, { title: string; pinned: boolean }>>;
    const post = await db.posts.create({ user_slug: actor.id, title: input.title, total: 0n });
    return { id: post.id, total: post.total };
  },
});
export type DraftPost = [
  Expect<Equal<OperationWireInput<typeof draftPost>, { title: string; pinned?: boolean | undefined }>>,
  Expect<Equal<OperationWireOutput<typeof draftPost>, { id: number; total: string }>>,
];

export const postSummary = defineOperation({
  name: "posts.summary",
  entity: "posts",
  method: "GET",
  output: z.object({ id: z.number(), title: z.string() }),
  authorize: () => true,
  execute: async ({ input, db }) => {
    const post = await db.posts.find(input.id);
    return post && { id: post.id, title: post.title };
  },
});

export const optionalPost = defineOperation({
  name: "posts.optional",
  entity: "posts",
  method: "GET",
  output: z.object({ id: z.number() }).nullable(),
  authorize: () => true,
  execute: async ({ input, db }) => {
    const post = await db.posts.find(input.id);
    return post && { id: post.id };
  },
});
export type OptionalPost = Expect<
  Equal<OperationWireOutput<typeof optionalPost>, { id: number } | null>
>;

export const hiddenPost = definePolicy({
  resource: ({ input, db }: PolicyContext<{ id: number }>) => db.posts.find(input.id),
  allow: ({ resource }) =>
    resource.score === null ? { deny: "not-found", reason: "hidden" } : true,
});

export const readVisiblePost = defineOperation({
  name: "posts.visible",
  entity: "posts",
  method: "GET",
  authorize: hiddenPost,
  execute: ({ resource }) => {
    type _Resource = Expect<Equal<typeof resource.id, PostRow["id"]>>;
    type _Title = Expect<Equal<typeof resource.title, PostRow["title"]>>;
    type _Total = Expect<Equal<typeof resource.total, PostRow["total"]>>;
    return resource;
  },
});

export const stampInput = z.object({ id: z.number(), at: z.string() });
export const recordStamp = defineOperation({
  name: "stamps.record",
  entity: "stamps",
  method: "PATCH",
  input: stampInput,
  authorize: ({ input }) => input.at.length > 0,
  execute: () => null,
});

export const signedIn = definePolicy({ allow: ({ actor }) => actor.id !== "" });

export const authorOnly = definePolicy({
  resource: ({ input, db }: PolicyContext<{ id: number }>) => db.posts.find(input.id),
  allow: ({ resource, actor }) => resource.user_slug === actor.id,
});

export const renamePost = defineOperation({
  name: "posts.rename",
  entity: "posts",
  method: "PATCH",
  authorize: authorOnly,
  execute: ({ input, db, resource }) => {
    const _show: [typeof resource, PostRow] = null as never;
    return db.posts.update(resource.id, input.changes);
  },
});

export const retitleOwnPost = defineOperation({
  name: "posts.retitleOwn",
  entity: "posts",
  method: "PATCH",
  input: z.object({ id: z.number(), title: z.string().trim() }),
  authorize: authorOnly,
  execute: ({ input, db, resource }) => {
    type _Input = Expect<Equal<typeof input, { id: number; title: string }>>;
    return db.posts.update(resource.id, { title: input.title });
  },
});
export type RetitleOwnPost = Expect<
  Equal<OperationWireInput<typeof retitleOwnPost>, { id: number; title: string }>
>;

export const readOwnPost = defineOperation({
  name: "posts.readOwn",
  entity: "posts",
  method: "GET",
  authorize: authorOnly,
  execute: ({ resource }) => resource,
});

export const removeOwnPost = defineOperation({
  name: "posts.removeOwn",
  entity: "posts",
  method: "DELETE",
  authorize: authorOnly,
  execute: ({ resource }) => resource.id > 0,
});

export const signedInCreate = defineOperation({
  name: "users.signedInCreate",
  entity: "users",
  method: "POST",
  authorize: signedIn,
  execute: ({ input, db, resource }) => {
    type _Resource = Expect<Equal<typeof resource, undefined>>;
    return db.users.create({ ...input, secret: "s" });
  },
});

export const signedInRead = defineOperation({
  name: "ledger.signedIn",
  entity: "ledger",
  method: "GET",
  authorize: signedIn,
  execute: ({ db, input }) => db.ledger.find(input.id),
});

export const inlineLookup = defineOperation({
  name: "posts.replaceScored",
  entity: "posts",
  method: "PUT",
  authorize: definePolicy({
    resource: ({ input, db }: PolicyContext<{ id: number }>) => db.posts.find(input.id),
    allow: ({ resource }) => resource.score !== null,
  }),
  execute: ({ db, resource, input }) => db.posts.update(resource.id, input.values),
});

declare const context: OperationContext<{ id: number }, PostRow>;
export const direct = authorOnly.allow(context);
export const directLookup = authorOnly.resource(context);
export const denied = authorOnly.allow({
  ...context,
  actor: { ...context.actor, id: "other" },
});
type Decision = true | false | { deny: "forbidden" | "not-found"; reason?: string };
export type Direct = [
  Expect<Equal<Awaited<typeof direct> extends Decision ? true : false, true>>,
  Expect<Equal<Awaited<typeof denied> extends Decision ? true : false, true>>,
  Expect<Same<Awaited<typeof directLookup>, PostRow | null | undefined>>,
];
`;

// Each probe names the diagnostic its next line must raise once the directive is gone.
const negative = `
import {
  defineOperation,
  definePolicy,
  type OperationWireInput,
  type OperationWireOutput,
  type PolicyContext,
} from "@databricks/appkit/beta";
import { z } from "zod";
// @ts-expect-error TS2305 operations run only through the HTTP runtime
import { runOperation } from "@databricks/appkit/beta";
// @ts-expect-error TS2305 candidate detection is internal
import { isOperationCandidate } from "@databricks/appkit/beta";
// @ts-expect-error TS2305 operation definitions are beta
import { defineOperation as stable } from "@databricks/appkit";
// @ts-expect-error TS2769 name is required
defineOperation({
  entity: "posts",
  method: "GET",
  authorize: () => true,
  execute: () => null,
});
// @ts-expect-error TS2769 authorize is required
defineOperation({
  name: "posts.missingAuthorize",
  entity: "posts",
  method: "GET",
  execute: ({ input, db }) => db.posts.find(input.id),
});
defineOperation({
  name: "missing.get",
  // @ts-expect-error TS2769 entities are generated table names
  entity: "missing",
  method: "GET",
  authorize: () => true,
  execute: () => null,
});
defineOperation({
  name: "posts.head",
  entity: "posts",
  // @ts-expect-error TS2769 methods are the five operation verbs
  method: "HEAD",
  authorize: () => true,
  execute: () => null,
});
defineOperation({
  // @ts-expect-error TS2769 an operation name is a string literal
  name: 1,
  entity: "posts",
  method: "GET",
  authorize: () => true,
  execute: () => null,
});
// @ts-expect-error TS2769 there is no separate action
defineOperation({
  name: "posts.get",
  entity: "posts",
  method: "GET",
  authorize: () => true,
  execute: () => null,
  action: "read",
});
defineOperation({
  name: "users.private",
  entity: "users",
  method: "POST",
  authorize: () => true,
  // @ts-expect-error TS2339 private columns are not part of the default input
  execute: ({ input, db }) => db.users.create({ ...input, secret: input.secret }),
});
defineOperation({
  name: "posts.partial",
  entity: "posts",
  method: "GET",
  authorize: () => true,
  // @ts-expect-error TS2769 a default read answers the full public row
  execute: () => ({ id: 1 }),
});
defineOperation({
  name: "posts.nullCreate",
  entity: "posts",
  method: "POST",
  authorize: () => true,
  // @ts-expect-error TS2769 a create answers a row, never a missing record
  execute: () => null,
});
defineOperation({
  name: "posts.badDelete",
  entity: "posts",
  method: "DELETE",
  authorize: () => true,
  // @ts-expect-error TS2769 a delete answers whether the record existed
  execute: () => "deleted",
});
defineOperation({
  name: "posts.badSummary",
  entity: "posts",
  method: "GET",
  output: z.object({ id: z.number(), title: z.string() }),
  authorize: () => true,
  // @ts-expect-error TS2769 a custom output constrains the executor to its input type
  execute: () => ({ id: "1", title: "x" }),
});
defineOperation({
  name: "posts.truthyNumber",
  entity: "posts",
  method: "GET",
  // @ts-expect-error TS2769 a decision is a boolean, not a truthy number
  authorize: () => 1,
  execute: () => null,
});
defineOperation({
  name: "posts.truthyString",
  entity: "posts",
  method: "GET",
  // @ts-expect-error TS2769 a decision is a boolean, not a truthy string
  authorize: async ({ actor }) => actor.email,
  execute: () => null,
});
defineOperation({
  name: "posts.badDenial",
  entity: "posts",
  method: "GET",
  // @ts-expect-error TS2769 a denial names forbidden or not-found
  authorize: () => ({ deny: "hidden", reason: "no" }),
  execute: () => null,
});
definePolicy({
  resource: ({ input }: PolicyContext<{ id: number }>) => input.id,
  // @ts-expect-error TS2769 a resource denial is the same decision
  allow: () => ({ deny: "missing" }),
});
defineOperation({
  name: "posts.email",
  entity: "posts",
  method: "GET",
  // @ts-expect-error TS18048 the actor email is optional
  authorize: ({ actor }) => actor.email.endsWith("@example.com"),
  execute: () => null,
});
defineOperation({
  name: "posts.noResource",
  entity: "posts",
  method: "GET",
  authorize: () => true,
  // @ts-expect-error TS18048 a decision loads no resource
  execute: ({ resource }) => resource.title,
});
definePolicy({
  // @ts-expect-error TS18048 an allow-only policy loads no resource
  allow: ({ resource }) => resource.title.length > 0,
});
definePolicy({
  resource: ({ input }: PolicyContext<{ id: number }>) => String(input.id),
  // @ts-expect-error TS2769 allow receives the lookup result
  allow: ({ resource }: { resource: number }) => resource > 0,
});
definePolicy({
  resource: () => Math.random() > 0.5 ? "row" : null,
  // @ts-expect-error TS2551 a nullable lookup is non-null after admission
  allow: ({ resource }) => resource.length > 0 && resource.toFixed() === "1",
});
const authorOnly = definePolicy({
  resource: ({ input, db }: PolicyContext<{ id: number }>) => db.posts.find(input.id),
  allow: ({ resource, actor }) => resource.user_slug === actor.id,
});
defineOperation({
  name: "posts.lookupCreate",
  entity: "posts",
  method: "POST",
  // @ts-expect-error TS2769 a default create carries no id for the lookup
  authorize: authorOnly,
  execute: ({ input, db }) => db.posts.create(input),
});
defineOperation({
  name: "users.wrongPolicy",
  entity: "users",
  method: "PATCH",
  // @ts-expect-error TS2769 a users id is a string slug
  authorize: authorOnly,
  execute: () => null,
});
defineOperation({
  name: "posts.secret",
  entity: "posts",
  method: "PATCH",
  authorize: authorOnly,
  // @ts-expect-error TS2339 the resource is the public row
  execute: ({ resource }) => resource.secret,
});
defineOperation({
  name: "events.get",
  entity: "events",
  method: "GET",
  authorize: () => true,
  execute: () => null,
  // @ts-expect-error TS2769 a keyless entity has no default id input
  input: undefined,
});
// @ts-expect-error TS2769 an empty public update has no default input
defineOperation({
  name: "stamps.patch",
  entity: "stamps",
  method: "PATCH",
  authorize: () => true,
  execute: () => null,
});
// @ts-expect-error TS2769 an empty public replacement has no default input
defineOperation({
  name: "stamps.put",
  entity: "stamps",
  method: "PUT",
  authorize: () => true,
  execute: () => null,
});
defineOperation({
  name: "events.delete",
  entity: "events",
  method: "DELETE",
  // @ts-expect-error TS2769 an explicit input must be a schema
  input: undefined,
  authorize: () => true,
  execute: () => true,
});
defineOperation({
  name: "posts.plugins",
  entity: "posts",
  method: "GET",
  authorize: () => true,
  execute: ({ appkit }) => {
    // @ts-expect-error TS18048 SDK plugins may be absent from the app
    appkit.analytics.query("q", {});
    // @ts-expect-error TS2339 custom plugins are not typed on the operation handle
    appkit.custom;
    return null;
  },
});
const replaceUser = defineOperation({
  name: "users.replace",
  entity: "users",
  method: "PUT",
  authorize: () => true,
  execute: ({ input, db }) => db.users.update(input.id, input.values),
});
// @ts-expect-error TS2741 a replacement carries every mutable public field
export const partial: OperationWireInput<typeof replaceUser> = { id: "ada", values: { name: "Ada" } };
const getEntry = defineOperation({
  name: "ledger.get",
  entity: "ledger",
  method: "GET",
  authorize: () => true,
  execute: ({ input, db }) => db.ledger.find(input.id),
});
// @ts-expect-error TS2322 JSON carries a bigint id as a string or safe integer
export const bigId: OperationWireInput<typeof getEntry> = { id: 1n };
export const safeBigId: OperationWireInput<typeof getEntry> = { id: 1 };
export const decimalBigId: OperationWireInput<typeof getEntry> = { id: "1" };
// @ts-expect-error TS2322 JSON answers a bigint as a decimal string
export const bigSeq: OperationWireOutput<typeof getEntry>["seq"] = 1n;
const patchPost = defineOperation({
  name: "posts.patch",
  entity: "posts",
  method: "PATCH",
  authorize: () => true,
  execute: ({ input, db }) => db.posts.update(input.id, input.changes),
});
// @ts-expect-error TS2322 a nested bigint change travels as a string or safe integer
export const bigChange: OperationWireInput<typeof patchPost> = { id: 1, changes: { total: 1n } };
export const decimalChange: OperationWireInput<typeof patchPost> = { id: 1, changes: { total: "1" } };
const getPost = defineOperation({
  name: "posts.get",
  entity: "posts",
  method: "GET",
  authorize: () => true,
  execute: ({ input, db }) => db.posts.find(input.id),
});
// @ts-expect-error TS2322 a successful read answers a row, never null
export const missing: OperationWireOutput<typeof getPost> = null;
const nullableSummary = defineOperation({
  name: "posts.nullableSummary",
  entity: "posts",
  method: "GET",
  output: z.object({ id: z.number(), title: z.string() }).nullable(),
  authorize: () => true,
  execute: () => null,
});
export const absentSummary: OperationWireOutput<typeof nullableSummary> = null;
const requiredSummary = defineOperation({
  name: "posts.requiredSummary",
  entity: "posts",
  method: "GET",
  output: z.object({ id: z.number() }),
  authorize: () => true,
  execute: () => ({ id: 1 }),
});
// @ts-expect-error TS2322 null is a successful body only when the output accepts it
export const rejectedSummary: OperationWireOutput<typeof requiredSummary> = null;
const deletePost = defineOperation({
  name: "posts.delete",
  entity: "posts",
  method: "DELETE",
  authorize: () => true,
  execute: ({ input, db }) => db.posts.delete(input.id),
});
// @ts-expect-error TS2322 a delete answers an empty body
export const deleted: OperationWireOutput<typeof deletePost> = true;
const createUser = defineOperation({
  name: "users.create",
  entity: "users",
  method: "POST",
  authorize: () => true,
  execute: ({ input, db }) => db.users.create({ ...input, secret: "s" }),
});
// @ts-expect-error TS2353 private columns are not wire inputs
export const leaked: OperationWireInput<typeof createUser> = { slug: "a", name: "A", secret: "s" };
// @ts-expect-error TS2339 private columns are not wire outputs
export type Leaked = OperationWireOutput<typeof createUser>["secret"];
// @ts-expect-error TS2540 descriptors are immutable
getPost.execute = () => null;
// @ts-expect-error TS2540 policies are immutable
authorOnly.allow = () => true;`;

const DIRECTIVE = /\/\/ @ts-expect-error (TS\d+) /g;

let root = "";
let declaration = "";
const parsed = new Map<string, ts.SourceFile>();

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "appkit-operations-"));
  const schemaFile = path.join(root, "schema.ts");
  declaration = path.join(root, "database.d.ts");
  await fs.writeFile(schemaFile, schemaSource);
  await generateDatabaseTypes({ schemaFile, outFile: declaration });
}, 30_000);

afterAll(() => fs.rm(root, { recursive: true, force: true }));

/** Every diagnostic in the generated declaration and the consumers, as `file:line TScode`. */
function typecheck(consumers: Record<string, string>, built = false): string[] {
  const entryRoot = built ? path.join(appkitRoot, "dist") : sourceRoot;
  const extension = built ? ".d.ts" : ".ts";
  const nodeTypes = path.dirname(
    path.dirname(
      createRequire(import.meta.url).resolve("@types/node/package.json"),
    ),
  );
  const { options, errors } = ts.parseJsonConfigFileContent(
    {
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        esModuleInterop: true,
        resolveJsonModule: true,
        skipLibCheck: false,
        types: ["node"],
        typeRoots: [nodeTypes],
        lib: ["ES2022"],
        baseUrl: root,
        paths: {
          "@databricks/appkit": [path.join(entryRoot, `index${extension}`)],
          "@databricks/appkit/beta": [path.join(entryRoot, `beta${extension}`)],
          shared: [path.join(sharedRoot, "index.ts")],
          "shared/*": [path.join(sharedRoot, "*")],
          "@databricks/lakebase": [
            path.resolve(appkitRoot, "../lakebase/src/index.ts"),
          ],
          zod: [zodRoot],
        },
      },
    },
    ts.sys,
    root,
  );
  expect(errors).toEqual([]);
  const virtual = new Map(
    Object.entries(consumers).map(([name, text]) => [
      path.join(root, name),
      text,
    ]),
  );
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.readFile = (file) => virtual.get(file) ?? readFile(file);
  host.getSourceFile = (file, language, ...rest) => {
    const text = virtual.get(file);
    if (text !== undefined) return ts.createSourceFile(file, text, language);
    if (!parsed.has(file)) {
      const source = getSourceFile(file, language, ...rest);
      if (source) parsed.set(file, source);
    }
    return parsed.get(file);
  };
  const files = [declaration, ...virtual.keys()];
  const program = ts.createProgram(files, options, host);
  const diagnostics = built
    ? ts.getPreEmitDiagnostics(program)
    : [
        ...program.getOptionsDiagnostics(),
        ...program.getGlobalDiagnostics(),
        ...files.flatMap((file) => {
          const source = program.getSourceFile(file);
          if (!source) throw new Error(`Missing consumer source ${file}`);
          return [
            ...program.getSyntacticDiagnostics(source),
            ...program.getSemanticDiagnostics(source),
          ];
        }),
      ];
  return diagnostics.map((diagnostic) => {
    const line = diagnostic.file
      ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start ?? 0)
          .line + 1
      : 0;
    const file = diagnostic.file ? path.basename(diagnostic.file.fileName) : "";
    return `${file}:${line} TS${diagnostic.code} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`;
  });
}

const byLine = (a: string, b: string) =>
  Number(a.split(/[: ]/)[1]) - Number(b.split(/[: ]/)[1]);

/** The `file:line TScode` each directive promises for the line after it. */
function expectedProbes(source: string): string[] {
  return source.split("\n").flatMap((text, index) => {
    const match = /\/\/ @ts-expect-error (TS\d+) /.exec(text);
    return match ? [`negative.ts:${index + 2} ${match[1]}`] : [];
  });
}

const globalContract = `
import type {
  DatabaseOperationContract,
  DatabricksAppKitDatabaseOperations,
} from "@databricks/appkit/beta";

declare global {
  interface DatabricksAppKitDatabaseOperations {
    "posts.get": {
      method: "GET";
      input: { id: number };
      output: { id: number; title: string; total: string };
    };
  }
}

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

export type GeneratedOperation = [
  Expect<Equal<DatabricksAppKitDatabaseOperations["posts.get"]["method"], "GET">>,
  Expect<Equal<DatabricksAppKitDatabaseOperations["posts.get"]["input"], { id: number }>>,
  Expect<
    Equal<
      DatabricksAppKitDatabaseOperations["posts.get"]["output"],
      { id: number; title: string; total: string }
    >
  >,
  Expect<
    Equal<
      Pick<DatabricksAppKitDatabaseOperations["posts.get"], "method" | "input" | "output">,
      { method: "GET"; input: { id: number }; output: { id: number; title: string; total: string } }
    >
  >,
];
`;

describe("operation definitions through the public entries", () => {
  test("infer entities, inputs, resources, and wire bodies from the generated registry", () => {
    expect(
      typecheck({ "positive.ts": positive, "global.ts": globalContract }),
    ).toEqual([]);
  }, 60_000);

  // Unit tests run before the build in CI; the build job runs this file after it.
  test.skipIf(!existsSync(path.join(appkitRoot, "dist/beta.d.ts")))(
    "consume built public declarations without suppressing library diagnostics",
    () => {
      expect(
        typecheck(
          { "positive.ts": positive, "global.ts": globalContract },
          true,
        ),
      ).toEqual([]);
    },
    60_000,
  );

  test("reject every probe, each with its own diagnostic", () => {
    expect(
      typecheck({ "positive.ts": positive, "negative.ts": negative }),
    ).toEqual([]);

    const raw = typecheck({
      "negative.ts": negative.replace(DIRECTIVE, "// probe $1 "),
    });
    expect(
      raw
        .map((finding) => finding.split(" ").slice(0, 2).join(" "))
        .sort(byLine),
    ).toEqual(expectedProbes(negative));
  }, 60_000);
});
