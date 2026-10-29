import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createServer, type ViteDevServer } from "vite";
import { afterEach, describe, expect, test } from "vitest";

import { compileGraph, designVitePlugin } from "../vite-plugin";

// A real Vite dev server: the status check must catch errors anywhere in the
// page's import graph, which a mocked transformRequest can't show. The sample
// modules avoid JSX so the temp app doesn't need React installed.
let server: ViteDevServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function serve(files: Record<string, string>) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "appkit-compile-")),
  );
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  server = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true, hmr: false, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  return server;
}

const INDEX = "/src/design/index.tsx";

describe("compileGraph on a real Vite server", () => {
  test("a page whose whole import graph builds", async () => {
    const s = await serve({
      "src/design/index.tsx":
        'import { Card } from "./Card";\nexport default () => Card();\n',
      "src/design/Card.tsx":
        'import { label } from "../lib/label";\nexport const Card = () => label;\n',
      "src/lib/label.ts": 'export const label = "ok";\n',
    });
    expect(await compileGraph(s, INDEX)).toBeUndefined();
  });

  test("a syntax error in a component two imports deep is reported", async () => {
    const s = await serve({
      "src/design/index.tsx":
        'import { Card } from "./Card";\nexport default () => Card();\n',
      "src/design/Card.tsx":
        'import { Bad } from "./Bad";\nexport const Card = () => Bad();\n',
      "src/design/Bad.tsx": "const x = {;\nexport const Bad = () => null;\n",
    });
    const error = await compileGraph(s, INDEX);
    // Names the broken module, not just the parser message.
    expect(error).toMatch(/Bad\.tsx/);
    expect(error).toMatch(/Unexpected/);
  });

  test("an unresolvable import in an imported module is reported", async () => {
    const s = await serve({
      "src/design/index.tsx":
        'import { Card } from "./Card";\nexport default () => Card();\n',
      "src/design/Card.tsx":
        'import { Nope } from "./nope";\nexport const Card = () => Nope();\n',
    });
    expect(await compileGraph(s, INDEX)).toMatch(
      /Failed to resolve import "\.\/nope"/,
    );
  });

  test("/design/__status reports it: compiled false, waitingFor compile", async () => {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "appkit-compile-")),
    );
    const write = (file: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    };
    write(
      "src/design/index.tsx",
      'import { Bad } from "./Bad";\nexport default () => Bad();\n',
    );
    write(
      "src/design/Bad.tsx",
      "const x = {;\nexport const Bad = () => null;\n",
    );
    server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      server: { middlewareMode: true, hmr: false, ws: false },
      optimizeDeps: { noDiscovery: true, include: [] },
    });
    // The plugin's own handler, on top of the real server's transformRequest,
    // moduleGraph and config (Vite's request pipeline isn't under test).
    type Handler = (
      req: unknown,
      res: unknown,
      next: () => void,
    ) => Promise<void>;
    let handler: Handler | undefined;
    const proxy = Object.create(server, {
      middlewares: { value: { use: (h: Handler) => (handler = h) } },
    });
    const plugin = designVitePlugin();
    (plugin.configResolved as (c: { root: string }) => void)({ root });
    (plugin.configureServer as (s: unknown) => void)(proxy);

    let body = "";
    await (handler as Handler)(
      { url: "/design/__status", method: "GET" },
      {
        statusCode: 200,
        setHeader() {},
        end: (b?: string) => (body = b ?? ""),
      },
      () => {},
    );
    const status = JSON.parse(body);
    expect(status).toMatchObject({ compiled: false, waitingFor: "compile" });
    expect(String(status.compileError)).toMatch(/Bad\.tsx.*Unexpected/);
  });
});
