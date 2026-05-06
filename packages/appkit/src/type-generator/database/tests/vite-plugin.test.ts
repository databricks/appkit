import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { appKitDatabaseTypesPlugin } from "../vite-plugin";

let pendingCleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of pendingCleanups) await cleanup();
  pendingCleanups = [];
});

describe("appKitDatabaseTypesPlugin", () => {
  test("injects generated columns through Vite fs resolution in dev", async () => {
    const projectRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "appkit-db-vite-project-"),
    );
    const clientRoot = path.join(projectRoot, "client");
    await fs.mkdir(clientRoot, { recursive: true });
    pendingCleanups.push(() =>
      fs.rm(projectRoot, { recursive: true, force: true }),
    );

    const columnsPath = path.join(
      projectRoot,
      "shared/appkit-types/database.columns.ts",
    );
    await fs.mkdir(path.dirname(columnsPath), { recursive: true });
    await fs.writeFile(columnsPath, "export {};\n", "utf8");

    const plugin = appKitDatabaseTypesPlugin();
    plugin.configResolved?.({
      root: clientRoot,
    } as Parameters<NonNullable<typeof plugin.configResolved>>[0]);

    const tags =
      typeof plugin.transformIndexHtml === "function"
        ? plugin.transformIndexHtml("", { server: {} } as never)
        : plugin.transformIndexHtml?.transform("");

    expect(tags).toEqual([
      {
        tag: "script",
        attrs: { type: "module" },
        children: `import ${JSON.stringify(
          `/@fs/${columnsPath.replace(/\\/g, "/")}`,
        )};\n`,
        injectTo: "head-prepend",
      },
    ]);
  });

  test("keeps a relative import for production builds", async () => {
    const projectRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "appkit-db-vite-project-"),
    );
    const clientRoot = path.join(projectRoot, "client");
    await fs.mkdir(clientRoot, { recursive: true });
    pendingCleanups.push(() =>
      fs.rm(projectRoot, { recursive: true, force: true }),
    );

    const columnsPath = path.join(
      projectRoot,
      "shared/appkit-types/database.columns.ts",
    );
    await fs.mkdir(path.dirname(columnsPath), { recursive: true });
    await fs.writeFile(columnsPath, "export {};\n", "utf8");

    const plugin = appKitDatabaseTypesPlugin();
    plugin.configResolved?.({
      root: clientRoot,
    } as Parameters<NonNullable<typeof plugin.configResolved>>[0]);

    const tags =
      typeof plugin.transformIndexHtml === "function"
        ? plugin.transformIndexHtml("")
        : plugin.transformIndexHtml?.transform("");

    expect(tags).toEqual([
      {
        tag: "script",
        attrs: { type: "module" },
        children: 'import "../shared/appkit-types/database.columns.ts";\n',
        injectTo: "head-prepend",
      },
    ]);
  });
});
