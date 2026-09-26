import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import { generateDatabaseTypes, NEUTRAL_DATABASE_TYPES } from "../generate";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const appkitRoot = path.resolve(import.meta.dirname, "../../../..");
const sourceRoot = path.join(appkitRoot, "src");
const builder = path.join(sourceRoot, "database/schema-builder/index.ts");
const uiRoot = path.resolve(appkitRoot, "../appkit-ui/src/js");

afterEach(async () =>
  Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  ),
);

async function files(source?: string) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "appkit-database-typegen-"),
  );
  roots.push(root);
  const schemaFile = path.join(root, "schema.ts");
  const outFile = path.join(root, "database.d.ts");
  if (source !== undefined) await fs.writeFile(schemaFile, source);
  return { root, schemaFile, outFile };
}

const completeSchema = `
  import {
    bigint, boolean, defineSchema, enumColumn, fk, id, integer, jsonb,
    text, timestamp, uuid, varchar,
  } from ${JSON.stringify(builder)};
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
      active: boolean().notNull(),
      external_id: uuid().defaultRandom().notNull(),
      happened_at: timestamp(),
      payload: jsonb(),
      status: enumColumn("post_status", ["draft", "live"]).notNull(),
    });
    const events = table("events", { message: text().notNull(), payload: jsonb() });
    const blobs = table("blobs", { payload: jsonb() });
    return { users, posts, events, blobs };
  });
`;

describe("generateDatabaseTypes", () => {
  test("renders every facet, scalar, enum, filter, relation, and key capability", async () => {
    const options = await files(completeSchema);
    await generateDatabaseTypes(options);
    const output = await fs.readFile(options.outFile, "utf8");

    expect(output).toContain('"slug": string;');
    expect(output).toContain('"score": number | null;');
    expect(output).toContain('"total": bigint;');
    expect(output).toContain('"active": boolean;');
    expect(output).toContain('"external_id": string;');
    expect(output).toContain('"happened_at": string | null;');
    expect(output).toContain('"payload": unknown | null;');
    expect(output).toContain('"status": "draft" | "live";');
    expect(output).toContain('readonly ("draft" | "live")[]');

    const users = output.slice(
      output.indexOf('"users": {'),
      output.indexOf('\n  "posts": {\n    row:'),
    );
    expect(users.match(/"secret"\??: string;/g)).toHaveLength(3);
    expect(users).toContain("publicRow:");
    expect(users).toContain('insert: {\n      "slug": string;');
    expect(users).toContain('"nickname"?: string | null;');
    expect(users).toContain('"created_at"?: string;');
    expect(users).not.toContain('update: {\n      "slug"');

    const posts = output.slice(
      output.indexOf('\n  "posts": {\n    row:'),
      output.indexOf('\n  "events": {\n    row:'),
    );
    expect(posts).not.toContain('insert: {\n      "id"');
    expect(posts).not.toContain('update: {\n      "id"');
    expect(posts).toContain('"title"?: string;');
    expect(posts).toContain('"score"?: number | null;');
    expect(posts).toContain('"users": { to: "users"; many: false };');
    expect(users).toContain('"posts": { to: "posts"; many: true };');
    expect(output).toContain("hasPrimaryKey: true;");
    expect(output).toContain("hasPrimaryKey: false;");

    expect(output).toContain(
      '"title"?: string | readonly (string)[] | { eq?: string; neq?: string; in?: readonly (string)[]; like?: string; ilike?: string; };',
    );
    expect(output).toContain(
      "gt?: number; gte?: number; lt?: number; lte?: number;",
    );
    expect(output).toContain("is?: null;");
    const postFilters = posts.slice(
      posts.indexOf("filters:"),
      posts.indexOf("includes:"),
    );
    expect(postFilters).not.toContain('"payload"?:');
    expect(output).toContain("and?: readonly DatabaseLogicalFilter<T>[];");
    expect(output).toContain("or?: readonly DatabaseLogicalFilter<T>[];");
    expect(output).toContain("includes: {};");
    expect(output).toContain("filters: DatabaseLogicalFilter<{}>;");
  });

  test("renders HTTP api facets from the route capabilities", async () => {
    const options = await files(completeSchema);
    await generateDatabaseTypes(options);
    const output = await fs.readFile(options.outFile, "utf8");
    const api = (table: string) => {
      const entry = output.indexOf(`\n  ${JSON.stringify(table)}: {\n    row:`);
      const start = output.indexOf("\n    api: {", entry);
      return output.slice(start, output.indexOf("\n    };", start));
    };

    // A private column reaches the trusted facets but none of the HTTP ones.
    const users = api("users");
    expect(users).not.toContain('"secret"');
    expect(users).toContain('insert: {\n        "slug": string;');
    expect(users).toContain('"created_at"?: string;');
    expect(users).toContain(
      'update: {\n        "name"?: string;\n        "nickname"?: string | null;\n      };',
    );
    expect(users).toContain(
      'orderable: "slug" | "name" | "nickname" | "created_at";',
    );
    expect(users).toContain('key: "slug";');

    // Server identities are never inputs, and a random default is no update.
    const posts = api("posts");
    expect(posts).not.toContain('insert: {\n        "id"');
    expect(posts).toContain('"external_id"?: string;');
    expect(posts).not.toContain('update: {\n        "id"');
    expect(
      posts.slice(posts.indexOf("update:"), posts.indexOf("filters:")),
    ).not.toContain('"external_id"');
    // HTTP filters have no bare-array shorthand and no JSON columns.
    expect(posts).toContain(
      '"status"?: "draft" | "live" | { eq?: "draft" | "live"; neq?: "draft" | "live"; in?: readonly ("draft" | "live")[]; };',
    );
    expect(posts.slice(posts.indexOf("filters:"))).not.toContain('"payload"');
    expect(posts).toContain('key: "id";');

    expect(api("events")).toContain('orderable: "message";');
    expect(api("events")).toContain("key: never;");
    expect(api("blobs")).toContain("filters: DatabaseLogicalFilter<{}>;");
    expect(api("blobs")).toContain("orderable: never;");
  });

  test("binds one entries interface into the server and UI registries", async () => {
    const options = await files(completeSchema);
    await generateDatabaseTypes(options);
    const output = await fs.readFile(options.outFile, "utf8");

    expect(output).toContain('import "@databricks/appkit";');
    expect(output).toContain('import "@databricks/appkit-ui/js/beta";');
    expect(
      output.match(/interface GeneratedDatabaseRegistry \{/g),
    ).toHaveLength(1);
    expect(output).toContain(
      'declare module "@databricks/appkit" {\n  interface DatabaseRegistry extends GeneratedDatabaseRegistry {}\n}',
    );
    expect(output).toContain(
      'declare module "@databricks/appkit-ui/js/beta" {\n  interface DatabaseRegistry extends GeneratedDatabaseRegistry {}\n}',
    );
  });

  test("accepts named valid and explicitly empty schemas", async () => {
    const valid = await files(completeSchema);
    await generateDatabaseTypes(valid);
    expect(await fs.readFile(valid.outFile, "utf8")).toContain('"users": {');

    const empty = await files(`
      import { defineSchema } from ${JSON.stringify(builder)};
      export const schema = defineSchema(() => ({}));
    `);
    await generateDatabaseTypes(empty);
    expect(await fs.readFile(empty.outFile, "utf8")).toContain(
      "interface GeneratedDatabaseRegistry {\n\n}",
    );
  });

  test.each([
    ["default", "export default {};"],
    ["alternate", "export const databaseSchema = {};"],
    ["forged", "export const schema = { $tables: {} };"],
  ])(
    "rejects %s schema exports and neutralizes stale output",
    async (_name, source) => {
      const options = await files(source);
      await fs.writeFile(options.outFile, "stale entity");
      await expect(generateDatabaseTypes(options)).rejects.toMatchObject({
        name: "DatabaseTypegenError",
      });
      expect(await fs.readFile(options.outFile, "utf8")).toBe(
        NEUTRAL_DATABASE_TYPES,
      );
    },
  );

  test("reports a bounded schema diagnostic while neutralizing output", async () => {
    const options = await files('throw new Error("broken schema dependency");');
    await fs.writeFile(options.outFile, "stale entity");

    const error = await generateDatabaseTypes(options).catch(
      (caught) => caught,
    );

    expect(error).toMatchObject({ name: "DatabaseTypegenError" });
    expect(error.message).toContain("schema.ts");
    expect(error.message).toContain("threw while loading");
    expect(error.message).not.toContain("broken schema dependency");
    expect(await fs.readFile(options.outFile, "utf8")).toBe(
      NEUTRAL_DATABASE_TYPES,
    );
  });

  test("writes a neutral contribution when the schema is absent", async () => {
    const options = await files();
    await generateDatabaseTypes(options);
    expect(await fs.readFile(options.outFile, "utf8")).toBe(
      NEUTRAL_DATABASE_TYPES,
    );
  });

  test("reloads schema and imported dependency edits", async () => {
    const options = await files();
    const dependency = path.join(options.root, "columns.ts");
    await fs.writeFile(
      dependency,
      `export const columnName = "first" as const;`,
    );
    const source = `
      import { defineSchema, text } from ${JSON.stringify(builder)};
      import { columnName } from "./columns";
      export const schema = defineSchema(({ table }) => {
        const records = table("records", { [columnName]: text() });
        return { records };
      });
    `;
    await fs.writeFile(options.schemaFile, source);
    await generateDatabaseTypes(options);
    expect(await fs.readFile(options.outFile, "utf8")).toContain('"first"');

    await fs.writeFile(
      dependency,
      `export const columnName = "second" as const;`,
    );
    await generateDatabaseTypes(options);
    expect(await fs.readFile(options.outFile, "utf8")).toContain('"second"');

    await fs.writeFile(
      options.schemaFile,
      source
        .replace('table("records"', 'table("updated"')
        .replace("return { records };", "return { updated: records };"),
    );
    await generateDatabaseTypes(options);
    expect(await fs.readFile(options.outFile, "utf8")).toContain(
      '"updated": {',
    );
  });

  test("does not rewrite an unchanged declaration", async () => {
    const options = await files(completeSchema);
    await generateDatabaseTypes(options);
    const content = await fs.readFile(options.outFile, "utf8");
    const before = (await fs.stat(options.outFile)).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await generateDatabaseTypes(options);
    expect(await fs.readFile(options.outFile, "utf8")).toBe(content);
    expect((await fs.stat(options.outFile)).mtimeMs).toBe(before);
  });

  // No UI package resolves here, so its binding must stay silent under skipLibCheck.
  test("compiles a server-only semantic consumer through the beta subpath", async () => {
    const options = await files(completeSchema);
    await generateDatabaseTypes(options);
    await compileConsumer(
      options,
      `
        import { database, type DatabaseExports, type IDatabaseConfig } from "@databricks/appkit/beta";
        database();
        database({});
        const defaults: IDatabaseConfig = { api: { writes: false } };
        database(defaults);
        database({
          api: { tables: ["posts"], writes: { operations: ["create"] } },
          hooks: {
            posts: {
              beforeCreate(values) {
                const title: string = values.title;
                // @ts-expect-error inferred hook fields are not any
                const invalid: number = values.title;
                return { ...values, title };
              },
            },
          },
        });
        // @ts-expect-error default API restrictions use generated table names
        database({ api: { tables: ["missing"] } });
        // @ts-expect-error default hooks use generated table names
        database({ hooks: { missing: { beforeCreate() {} } } });
        declare const db: DatabaseExports;
        db.users.where({ name: { ilike: "%ada%" } }).include({ posts: { limit: 2 } });
        db.posts.where({ score: { gte: 1 }, and: [{ status: ["draft"] }] });
        db.events.create({ message: "created" });
        db.transaction(async (tx) => { await tx.posts.count(); await tx.sql\`select \${1}\`; });
        // @ts-expect-error keyless entities have no find
        db.events.find("id");
        // @ts-expect-error private columns are absent from default rows
        db.users.first().then((row) => row?.secret);
        db.users.create({ slug: "ada", name: "Ada", secret: "token" });
        db.users.upsert(
          { slug: "ada", name: "Ada", secret: "token" },
          { onConflict: "slug" },
        );
        // @ts-expect-error unknown columns are not conflict targets
        db.users.upsert({ slug: "ada", name: "Ada", secret: "token" }, { onConflict: "missing" });
        // @ts-expect-error defaulted fields remain typed when explicitly supplied
        db.users.create({ slug: "ada", name: "Ada", secret: "token", nickname: 1 });
      `,
    );
  }, 30_000);

  test("compiles a browser consumer bound to the same generated entries", async () => {
    const options = await files(completeSchema);
    await generateDatabaseTypes(options);
    await compileConsumer(
      options,
      `
        import { type DatabaseExports } from "@databricks/appkit/beta";
        import {
          databaseApi,
          DatabaseApiError,
          type DatabaseEntity,
          type DatabaseListRow,
        } from "@databricks/appkit-ui/js/beta";

        // The server entities and the browser entities are one registry.
        declare const db: DatabaseExports;
        const server: keyof DatabaseExports = "users";
        const entity: DatabaseEntity = "users";
        void [db, server, entity];
        // @ts-expect-error browser entities are generated table names
        const missing: DatabaseEntity = "missing";
        void missing;

        async function reads() {
          const users = await databaseApi.list("users", {
            where: { name: { ilike: "%ada%" }, or: [{ nickname: { is: null } }] },
            order: { created_at: "desc" },
            include: { posts: { limit: 2, select: ["title", "total"] } },
          });
          const title: string | undefined = users.items[0]?.posts[0]?.title;
          // A bigint travels as its decimal string.
          const total: string | undefined = users.items[0]?.posts[0]?.total;
          // @ts-expect-error private columns are absent from public rows
          users.items[0]?.secret;
          // @ts-expect-error unselected relation columns are absent
          users.items[0]?.posts[0]?.score;

          const posts = await databaseApi.list("posts", {
            select: ["id", "title"],
            include: { users: { include: { posts: { limit: 1 } } } },
          });
          const owner: { slug: string; name: string } | null | undefined =
            posts.items[0]?.users;
          const nested: number | undefined = posts.items[0]?.users?.posts[0]?.id;
          // @ts-expect-error unselected columns are absent
          posts.items[0]?.score;
          void [title, total, owner, nested];

          type Picked = DatabaseListRow<"posts", { select: readonly ["id"] }>;
          const picked: Picked = { id: 1 };
          void picked;

          await databaseApi.list("posts", { where: { total: { gt: "9007199254740993" } } });
          await databaseApi.list("events", { order: { message: "asc" } });
        }

        async function rejected() {
          // @ts-expect-error private columns are not HTTP filters, even beside a valid one
          await databaseApi.list("users", { where: { name: "Ada", secret: "token" } });
          // @ts-expect-error private columns are not selectable
          await databaseApi.list("users", { select: ["slug", "secret"] });
          // @ts-expect-error private columns cannot order a list
          await databaseApi.list("users", { order: { name: "asc", secret: "asc" } });
          // @ts-expect-error JSON columns are not queryable
          await databaseApi.list("posts", { where: { payload: { eq: 1 } } });
          // @ts-expect-error HTTP filters have no bare-array shorthand
          await databaseApi.list("posts", { where: { status: ["draft"] } });
          // @ts-expect-error unknown operators are rejected inside an operator object
          await databaseApi.list("posts", { where: { score: { gte: 1, near: 2 } } });
          // @ts-expect-error a to-one include takes no limit
          await databaseApi.list("posts", { include: { users: { limit: 1 } } });
          // @ts-expect-error includes stop at two relation edges
          await databaseApi.list("users", { include: { posts: { include: { users: { include: { posts: true } } } } } });
          // @ts-expect-error an include filter checks the target's public facets
          await databaseApi.list("posts", { include: { users: { where: { name: "Ada", secret: "x" } } } });
          // @ts-expect-error generated routes decode includes as true or options, never false
          await databaseApi.list("users", { include: { posts: false } });
          // @ts-expect-error list params are the generated route's parameters only
          await databaseApi.list("users", { limit: 1, includeTotal: true });
        }

        function failed(error: unknown) {
          if (error instanceof DatabaseApiError && error.code === "NOT_EXPOSED") {
            const status: number | null = error.status;
            return status;
          }
          return error instanceof DatabaseApiError ? error.details[0]?.message : undefined;
        }
        void [reads, rejected, failed];
      `,
      { ui: true },
    );
  }, 30_000);
});

/** Type-check `source` against the generated declaration, as an app would. */
async function compileConsumer(
  options: { root: string; outFile: string },
  source: string,
  { ui = false } = {},
): Promise<void> {
  const consumer = path.join(options.root, "consumer.ts");
  const tsconfig = path.join(options.root, "tsconfig.json");
  await fs.writeFile(consumer, source);
  await fs.writeFile(
    tsconfig,
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        esModuleInterop: true,
        resolveJsonModule: true,
        skipLibCheck: true,
        baseUrl: options.root,
        paths: {
          "@databricks/appkit": [
            path.join(sourceRoot, "database/contract/index.ts"),
          ],
          "@databricks/appkit/beta": [
            path.join(sourceRoot, "plugins/database/index.ts"),
          ],
          ...(ui
            ? {
                "@databricks/appkit-ui/js/beta": [path.join(uiRoot, "beta.ts")],
              }
            : {}),
          shared: [path.resolve(appkitRoot, "../shared/src/index.ts")],
          // CI runs unit tests before build, including imports of shared subpaths.
          "shared/*": [path.resolve(appkitRoot, "../shared/src/*")],
          "@databricks/lakebase": [
            path.resolve(appkitRoot, "../lakebase/src/index.ts"),
          ],
        },
      },
      files: [options.outFile, consumer],
    }),
  );

  await expect(
    execFileAsync("pnpm", ["exec", "tsc", "--noEmit", "-p", tsconfig], {
      cwd: path.resolve(appkitRoot, "../.."),
    }),
  ).resolves.toMatchObject({ stderr: "" });
}
