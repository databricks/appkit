import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
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
// One @types/node copy, so source modules and Express agree on Node's types.
const nodeTypes = path.dirname(
  path.dirname(
    createRequire(import.meta.url).resolve("@types/node/package.json"),
  ),
);

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

  test("renders the HTTP facets default operation contracts read", async () => {
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
    expect(users).toContain('key: "slug";');
    // Default contracts neither filter nor order, so no such facet ships.
    expect(users).not.toContain("filters:");
    expect(users).not.toContain("orderable:");

    // Server identities are never inputs, and a random default is no update.
    const posts = api("posts");
    expect(posts).not.toContain('insert: {\n        "id"');
    expect(posts).toContain('"external_id"?: string;');
    expect(posts).not.toContain('update: {\n        "id"');
    expect(
      posts.slice(posts.indexOf("update:"), posts.indexOf("key:")),
    ).not.toContain('"external_id"');
    expect(posts).toContain('key: "id";');

    expect(api("events")).toContain("key: never;");
    expect(api("blobs")).toContain("key: never;");
  });

  test("treats boolean and JSON primary keys as keyless only over HTTP", async () => {
    const options = await files(`
      import { boolean, defineSchema, jsonb, text } from ${JSON.stringify(builder)};
      export const schema = defineSchema(({ table }) => ({
        flags: table("flags", { key: boolean().primaryKey(), label: text() }),
        documents: table("documents", { key: jsonb().primaryKey(), label: text() }),
      }));
    `);
    await generateDatabaseTypes(options);
    await compileConsumer(
      options,
      `
      import type { DatabaseRegistry } from "@databricks/appkit";
      type Equal<A, B> =
        (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
      type Expect<T extends true> = T;
      // Trusted server code keeps the key; the HTTP facet has none to default to.
      export type Keys = [
        Expect<Equal<DatabaseRegistry["flags"]["hasPrimaryKey"], true>>,
        Expect<Equal<DatabaseRegistry["flags"]["api"]["key"], never>>,
        Expect<Equal<DatabaseRegistry["documents"]["api"]["key"], never>>,
      ];
    `,
    );
  }, 30_000);

  test("binds one registry without importing an optional UI package", async () => {
    const options = await files(completeSchema);
    await generateDatabaseTypes(options);
    const output = await fs.readFile(options.outFile, "utf8");

    expect(output).toContain('import "@databricks/appkit";');
    expect(output).not.toContain('import "@databricks/appkit-ui/js/beta";');
    expect(
      output.match(/interface GeneratedDatabaseRegistry \{/g),
    ).toHaveLength(1);
    expect(output).toContain(
      'declare module "@databricks/appkit" {\n  interface DatabaseRegistry extends GeneratedDatabaseRegistry {}\n}',
    );
    expect(output).not.toContain("declare global");
    expect(output).not.toContain("DatabricksAppKitDatabaseRegistry");
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

  test("compiles a server-only semantic consumer through the beta subpath", async () => {
    const options = await files(completeSchema);
    await generateDatabaseTypes(options);
    await compileConsumer(
      options,
      `
        import { database, type DatabaseExports, type IDatabaseConfig } from "@databricks/appkit/beta";
        database();
        database({});
        const disabled: IDatabaseConfig = { routes: false };
        database(disabled);
        declare const routes: Exclude<IDatabaseConfig["routes"], false | undefined>;
        database({ routes });
        // @ts-expect-error automatic table routes were removed
        database({ api: { writes: false } });
        // @ts-expect-error lifecycle hooks were removed
        database({ hooks: { posts: {} } });
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

  test("typechecks the generated server declaration without UI or skipLibCheck", async () => {
    const options = await files(completeSchema);
    await generateDatabaseTypes(options);
    await fs.writeFile(
      path.join(options.root, "appkit.d.ts"),
      "export interface DatabaseRegistry {}",
    );
    await compileConsumer(
      options,
      `import type { DatabaseRegistry } from "@databricks/appkit";
       const slug: string = ({} as DatabaseRegistry["users"]["publicRow"]).slug;
       void slug;`,
      { skipLibCheck: false, isolated: true },
    );
  }, 30_000);
});

/** Type-check `source` against the generated declaration, as an app would. */
async function compileConsumer(
  options: { root: string; outFile: string },
  source: string,
  { skipLibCheck = true, isolated = false } = {},
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
        skipLibCheck,
        ...(isolated
          ? { types: [] }
          : { lib: ["ES2022"], types: ["node"], typeRoots: [nodeTypes] }),
        baseUrl: options.root,
        paths: {
          "@databricks/appkit": [
            isolated
              ? path.join(options.root, "appkit.d.ts")
              : path.join(sourceRoot, "database/contract/index.ts"),
          ],
          "@databricks/appkit/beta": [
            path.join(sourceRoot, "plugins/database/index.ts"),
          ],
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
