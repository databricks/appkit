import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { appKitDatabaseTypesPlugin } from "../vite-plugin";

// Vite hooks are typed as `T | ObjectHook<T>`; extract the underlying fn so
// tests can invoke them regardless of how the plugin author wrote them.
function extractHook<T extends (...args: never[]) => unknown>(
  hook: T | { handler: T } | undefined,
): T | undefined {
  if (!hook) return undefined;
  return typeof hook === "function" ? hook : hook.handler;
}

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
    const configResolved = extractHook(plugin.configResolved);
    configResolved?.call({} as never, { root: clientRoot } as never);

    const transformIndexHtml = extractHook(plugin.transformIndexHtml);
    const tags = transformIndexHtml?.call({} as never, "", {
      server: {},
    } as never);

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
    const configResolved = extractHook(plugin.configResolved);
    configResolved?.call({} as never, { root: clientRoot } as never);

    const transformIndexHtml = extractHook(plugin.transformIndexHtml);
    const tags = transformIndexHtml?.call({} as never, "", {} as never);

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
