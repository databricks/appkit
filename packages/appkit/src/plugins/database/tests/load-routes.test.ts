import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { loadDefaultDatabaseRoutes } from "../load-routes";

const roots: string[] = [];
const registry = (marker: string) => `export const databaseRoutes = {
  schema: async () => ({ schema: { marker: ${JSON.stringify(marker)} } }),
  modules: [{ file: "server/database/routes/notes.ts", load: async () => ({ marker: ${JSON.stringify(marker)} }) }],
};`;

async function fixture(files: Record<string, string> = {}) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "appkit-default-routes-"),
  );
  roots.push(root);
  for (const [file, contents] of Object.entries({
    "package.json": '{"type":"module"}',
    ...files,
  })) {
    const target = path.join(root, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, contents);
  }
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("default database routes", () => {
  test("loads the source convention without an application import", async () => {
    const root = await fixture({
      "server/database/routes.gen.ts": registry("source"),
    });
    const routes = await loadDefaultDatabaseRoutes(root);
    expect(await routes?.modules[0].load()).toEqual({ marker: "source" });
  });

  test("uses the application working directory by default", async () => {
    const root = await fixture({
      "server/database/routes.gen.ts": registry("cwd"),
    });
    vi.spyOn(process, "cwd").mockReturnValue(root);
    expect(
      await (await loadDefaultDatabaseRoutes())?.modules[0].load(),
    ).toEqual({ marker: "cwd" });
  });

  test.each(["js", "mjs"])(
    "loads the compiled %s entry beside a server in a custom output directory",
    async (extension) => {
      const root = await fixture({
        [`build/database/routes.gen.${extension}`]: registry("compiled"),
      });
      const routes = await loadDefaultDatabaseRoutes(
        root,
        path.join(root, `build/server.${extension}`),
      );
      expect(await routes?.modules[0].load()).toEqual({ marker: "compiled" });
    },
  );

  test("prefers the compiled registry over source in a built application", async () => {
    const root = await fixture({
      "server/database/routes.gen.ts":
        'throw new Error("source must not run");',
      "dist/database/routes.gen.js": registry("compiled"),
    });
    const routes = await loadDefaultDatabaseRoutes(
      root,
      path.join(root, "dist/server.js"),
    );
    expect(await routes?.modules[0].load()).toEqual({ marker: "compiled" });
  });

  test("serves no operations when the application has no routes", async () => {
    expect(await loadDefaultDatabaseRoutes(await fixture())).toBeUndefined();
  });

  test("fails with generation guidance when routes exist but the registry is missing", async () => {
    const root = await fixture({
      "server/database/routes/notes.ts": "export {};",
    });
    await expect(loadDefaultDatabaseRoutes(root)).rejects.toThrow(
      "appkit generate-types",
    );
  });

  test.each([
    "export const databaseRoutes = {};",
    "export default {};",
    'throw new Error("private details");',
  ])("fails closed on an invalid or broken registry", async (source) => {
    const root = await fixture({ "server/database/routes.gen.ts": source });
    const error = await loadDefaultDatabaseRoutes(root).catch(
      (caught) => caught,
    );
    expect(error).toMatchObject({ category: "SETUP_FAILED", cause: undefined });
    expect(error.message).not.toContain("private details");
  });
});
