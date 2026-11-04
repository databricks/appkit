import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

const require = createRequire(import.meta.url);
const appkit = path.resolve(
  fileURLToPath(new URL("../../../..", import.meta.url)),
);

test("the standard watcher reloads first, edited, shared, added, and deleted operations", async () => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "appkit-watch-")),
  );
  const write = async (name: string, contents: string) => {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, contents);
  };
  const source = (name: string) =>
    JSON.stringify(path.join(appkit, "src", name));
  const route = (name: string, marker: string) => `
    import { defineOperation } from ${source("plugins/database/operations.ts")};
    import { row } from "../rows";
    export const marker = ${JSON.stringify(marker)};
    export const operation = defineOperation({ name: ${JSON.stringify(name)}, method: "GET", output: row, authorize: () => true, execute: () => ({ body: "ok" }) });
  `;
  await fs.symlink(
    path.resolve(appkit, "../../node_modules"),
    path.join(root, "node_modules"),
    "dir",
  );
  await write("package.json", '{"type":"module"}');
  await write("client/index.html", "<html><body></body></html>");
  await write(
    "config/database/schema.ts",
    `import { defineSchema, id, text } from ${source("database/schema-builder/index.ts")}; export const schema = defineSchema(({ table }) => ({ notes: table("notes", { id: id(), body: text().notNull() }) }));`,
  );
  await write(
    "server/database/rows.ts",
    'import { z } from "zod"; export const row = z.object({ body: z.string() });',
  );
  await write(
    "server/main.ts",
    `
    import { loadDefaultDatabaseRoutes } from ${source("plugins/database/load-routes.ts")};
    import { appKitTypesPlugin } from ${source("type-generator/vite-plugin.ts")};
    import { createServer } from ${JSON.stringify(require.resolve("vite"))};
    const routes = await loadDefaultDatabaseRoutes();
    await routes.schema();
    const modules = await Promise.all(routes.modules.map(module => module.load()));
    const vite = await createServer({ configFile: false, root: ${JSON.stringify(path.join(root, "client"))}, plugins: [appKitTypesPlugin()], server: { middlewareMode: true, hmr: false } });
    console.log("BOOT " + JSON.stringify(modules.map(module => ({ name: module.operation.name, marker: module.marker, type: module.operation.output.shape.body.type }))));
    process.on("SIGTERM", async () => { await vite.close(); process.exit(0); });
    setInterval(() => {}, 1000);
  `,
  );
  let output = "";
  const child = spawn(
    process.execPath,
    [
      require.resolve("tsx/cli"),
      "watch",
      "--clear-screen=false",
      "server/main.ts",
    ],
    {
      cwd: root,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        NODE_ENV: "development",
        DATABRICKS_WAREHOUSE_ID: "",
      },
    },
  );
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  type Boot = { name: string; marker: string; type: string }[];
  const boots = (): Boot[] =>
    output
      .split("\n")
      .filter((line) => line.startsWith("BOOT "))
      .map((line) => JSON.parse(line.slice(5)));
  const until = async (matches: (boot: Boot) => boolean) => {
    const deadline = Date.now() + 10_000;
    while (!boots().some(matches)) {
      if (Date.now() > deadline)
        throw new Error(
          `Watcher did not load the expected operations:\n${output}`,
        );
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  try {
    await until((boot) => boot.length === 0);
    await write("server/database/routes/notes.ts", route("notes.get", "first"));
    await until((boot) => boot[0]?.marker === "first");
    await write(
      "server/database/routes/notes.ts",
      route("notes.get", "edited"),
    );
    await until((boot) => boot[0]?.marker === "edited");
    await write(
      "server/database/rows.ts",
      'import { z } from "zod"; export const row = z.object({ body: z.number() });',
    );
    await until((boot) => boot[0]?.type === "number");
    expect(
      await fs.readFile(
        path.join(root, "shared/appkit-types/database-operations.d.ts"),
        "utf8",
      ),
    ).toContain('"body": number');
    await write(
      "server/database/routes/added.ts",
      route("notes.added", "added"),
    );
    await until((boot) => boot.length === 2);
    await fs.rm(path.join(root, "server/database/routes/notes.ts"));
    await until((boot) => boot.length === 1 && boot[0]?.name === "notes.added");
    const beforeLastDelete = boots().length;
    await fs.rm(path.join(root, "server/database/routes/added.ts"));
    const deadline = Date.now() + 10_000;
    while (boots().length <= beforeLastDelete || boots().at(-1)?.length !== 0) {
      if (Date.now() > deadline)
        throw new Error(`Final route deletion did not reload:\n${output}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const settled = boots().length;
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(boots()).toHaveLength(settled);
  } finally {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* already stopped */
      }
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}, 60_000);
