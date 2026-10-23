/**
 * Prove a built AppKit server loads its database operations without source.
 *
 * Builds a fixture app with the template's `appkitServerConfig()` preset,
 * moves every `.ts` source away, and runs the output under plain Node. The
 * fixture's entry loads the generated `databaseRoutes` registry, its schema,
 * and each operation module. No database or workspace is contacted.
 *
 * Run after `pnpm build`: `pnpm exec tsx tools/verify-database-bundle.ts`
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { generateDatabaseOperations } from "../packages/appkit/src/type-generator/database/generate-operations";

const run = promisify(execFile);
const repo = path.resolve(import.meta.dirname, "..");
const appkit = path.join(repo, "packages/appkit");
const zod = path.dirname(
  createRequire(path.join(appkit, "package.json")).resolve("zod/package.json"),
);
const tsdown = path.join(repo, "node_modules/.bin/tsdown");

const fixture: Record<string, string> = {
  "package.json": JSON.stringify({ name: "bundle-fixture", type: "module" }),
  "tsdown.server.config.ts": `import { appkitServerConfig } from "@databricks/appkit/tsdown";
export default appkitServerConfig();
`,
  "config/database/schema.ts": `import { defineSchema, id, text } from "@databricks/appkit/beta";
export const schema = defineSchema(({ table }) => ({
  notes: table("notes", { id: id(), body: text().notNull() }),
}));
`,
  "server/database/routes/notes.ts": `import { defineOperation } from "@databricks/appkit/beta";
import { z } from "zod";
export const getNote = defineOperation({
  name: "notes.get",
  entity: "notes",
  method: "GET",
  authorize: ({ actor }) => actor.id !== "",
  execute: ({ input, db }) => db.notes.find(input.id),
});
export const searchNotes = defineOperation({
  name: "notes.search",
  entity: "notes",
  method: "GET",
  input: z.object({ q: z.string() }),
  output: z.array(z.object({ id: z.number(), body: z.string() })),
  authorize: () => true,
  execute: ({ input, db }) => db.notes.where({ body: { ilike: input.q } }).all(),
});
`,
  "server/database/routes/stats.ts": `import { defineOperation } from "@databricks/appkit/beta";
import { z } from "zod";
export const countNotes = defineOperation({
  name: "notes.count",
  entity: "notes",
  method: "GET",
  input: z.object({}),
  output: z.number(),
  authorize: () => true,
  execute: ({ db }) => db.notes.count(),
});
`,
  "server/server.ts": `import { databaseRoutes } from "./database/routes.gen";
const { schema } = await databaseRoutes.schema();
const operations: string[] = [];
for (const module of databaseRoutes.modules) {
  for (const value of Object.values(await module.load())) {
    operations.push(\`\${String(Reflect.get(Object(value), "name"))} \${String(Reflect.get(Object(value), "method"))}\`);
  }
}
console.log(JSON.stringify({ tables: Object.keys(schema.$tables), operations }));
`,
};

async function main(): Promise<void> {
  await fs.access(path.join(appkit, "dist/beta.js")).catch(() => {
    throw new Error("Build first: packages/appkit/dist/beta.js is missing.");
  });
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "appkit-database-bundle-"),
  );
  try {
    for (const [file, content] of Object.entries(fixture)) {
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await fs.writeFile(path.join(root, file), content);
    }
    await fs.mkdir(path.join(root, "node_modules/@databricks"), {
      recursive: true,
    });
    await fs.symlink(
      appkit,
      path.join(root, "node_modules/@databricks/appkit"),
    );
    await fs.symlink(zod, path.join(root, "node_modules/zod"));

    await generateDatabaseOperations({
      appRoot: root,
      outFile: path.join(root, "shared/appkit-types/database-operations.d.ts"),
      strict: true,
    });
    await run(tsdown, ["-c", "tsdown.server.config.ts"], { cwd: root });

    // Production must not need any TypeScript source.
    const removed = path.join(root, ".removed-sources");
    await fs.mkdir(removed);
    for (const directory of ["server", "config", "shared"]) {
      await fs.rename(
        path.join(root, directory),
        path.join(removed, directory),
      );
    }
    const built = await fs.readdir(path.join(root, "dist"), {
      recursive: true,
    });
    const sources = built.filter((file) => /\.(?:c|m)?ts$/.test(file));
    if (sources.length > 0) {
      throw new Error(
        `The build emitted TypeScript sources: ${sources.join(", ")}`,
      );
    }

    const { stdout } = await run(process.execPath, ["dist/server.js"], {
      cwd: root,
    });
    const result: unknown = JSON.parse(stdout.trim());
    const expected = {
      tables: ["notes"],
      operations: ["notes.get GET", "notes.search GET", "notes.count GET"],
    };
    if (JSON.stringify(result) !== JSON.stringify(expected)) {
      throw new Error(
        `Unexpected output ${JSON.stringify(result)}; expected ${JSON.stringify(expected)}`,
      );
    }
    console.log(
      `Source-less bundle loaded ${expected.operations.length} operations from ${built.length} built files.`,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

await main();
