import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { designVitePlugin } from "../vite-plugin";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "appkit-status-"));

describe("/design/__status", () => {
  const cwd = process.cwd();
  afterEach(() => process.chdir(cwd));

  type Handler = (
    req: { url: string; method: string; body?: unknown },
    res: {
      statusCode: number;
      setHeader(k: string, v: string): void;
      end(body?: string): void;
    },
    next: () => void,
  ) => Promise<void>;

  async function call(
    handler: Handler,
    method: string,
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    let out = "";
    const set: Record<string, string> = {};
    const res = {
      statusCode: 200,
      setHeader: (k: string, v: string) => (set[k.toLowerCase()] = v),
      end: (b?: string) => (out = b ?? ""),
    };
    await handler({ url, method, body, headers } as never, res, () => {});
    let json: unknown;
    try {
      json = out ? JSON.parse(out) : undefined;
    } catch {}
    return { status: res.statusCode, json: json as any, headers: set };
  }
  function start(
    transformRequest: (url: string) => Promise<unknown> = async () => ({}),
    builderOrigins: string[] = [],
  ) {
    const app = tmp();
    process.chdir(app);
    const plugin = designVitePlugin({ builderOrigins });
    let handler: Handler | undefined;
    (plugin.configureServer as (s: unknown) => void)({
      config: { root: path.join(app, "client") },
      ws: { send() {} },
      middlewares: { use: (h: Handler) => (handler = h) },
      transformRequest,
      moduleGraph: { getModuleByUrl: async () => undefined },
    });
    return { app, handler: handler as Handler };
  }

  const writeIndex = (app: string, text: string) => {
    const file = path.join(app, "client/src/design/index.tsx");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };

  test("compiled and waitingFor tell an agent what /design waits on, without a browser", async () => {
    const S = "/design/__status";
    const ok = start();
    expect((await call(ok.handler, "GET", S)).json).toMatchObject({
      ready: false,
      compiled: false,
      waitingFor: "index",
    });
    writeIndex(
      ok.app,
      "export const designPlaceholder = true;\nexport default () => null;",
    );
    expect((await call(ok.handler, "GET", S)).json.waitingFor).toBe(
      "placeholder",
    );
    writeIndex(ok.app, "export default () => null;");
    expect((await call(ok.handler, "GET", S)).json).toMatchObject({
      ready: false,
      compiled: true,
      waitingFor: "paint",
    });

    const broken = start(async () => {
      throw new Error(
        'Failed to resolve import "./nope" from "src/design/index.tsx"',
      );
    });
    writeIndex(broken.app, 'import "./nope";\nexport default () => null;');
    expect((await call(broken.handler, "GET", S)).json).toMatchObject({
      compiled: false,
      compileError: expect.stringContaining("Failed to resolve import"),
      waitingFor: "compile",
    });
  });

  // Not a dashboard: a multi-page tool with a settings form.
  // Not a dashboard: a multi-page tool with a settings form.
  test("reports each page and the app as rendered, with errors, from browser reports only", async () => {
    const compileErrors: Record<string, string> = {};
    const { app, handler } = start(async (url) => {
      if (compileErrors[url]) throw new Error(compileErrors[url]);
      return {};
    });
    writeIndex(app, "export default () => null;");
    fs.mkdirSync(path.join(app, "client/src/design/pages"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(app, "client/src/design/pages/settings.tsx"),
      "export default () => null;",
    );
    fs.writeFileSync(
      path.join(app, "client/index.html"),
      '<div id="root"></div><script type="module" src="/src/main.tsx"></script>',
    );
    const S = "/design/__status";
    const get = async () => (await call(handler, "GET", S)).json;

    // Nothing reported yet: not rendered, errors unknown.
    let status = await get();
    expect(status.pages).toEqual([
      {
        name: "index",
        path: "/design",
        compiled: true,
        rendered: false,
        errors: null,
        state: "rendering",
      },
      {
        name: "settings",
        path: "/design/settings",
        compiled: true,
        rendered: false,
        errors: null,
        state: "rendering",
      },
    ]);
    expect(status.app).toEqual({
      entry: "/src/main.tsx",
      compiled: true,
      path: null,
      rendered: false,
      template: false,
      errors: null,
    });

    // A hidden preview loads both pages and the app; the settings form's
    // submit handler throws later.
    for (const page of ["index", "settings"]) {
      await call(handler, "POST", S, { page, reset: true });
      await call(handler, "POST", S, { page, ok: true });
    }
    await call(handler, "POST", S, {
      page: "settings",
      error: "Unhandled rejection: save failed",
    });
    await call(handler, "POST", S, { app: "/", reset: true });
    await call(handler, "POST", S, { app: "/", ok: true, template: false });
    status = await get();
    expect(status).toMatchObject({ ready: true, waitingFor: null });
    expect(status.pages).toEqual([
      {
        name: "index",
        path: "/design",
        compiled: true,
        rendered: true,
        errors: [],
        state: "ready",
      },
      {
        name: "settings",
        path: "/design/settings",
        compiled: true,
        rendered: true,
        errors: [{ error: "Unhandled rejection: save failed" }],
        state: "failed",
      },
    ]);
    expect(status.app).toMatchObject({ path: "/", rendered: true, errors: [] });

    // Editing a page makes its report stale: unknown again until it reports.
    const settings = path.join(app, "client/src/design/pages/settings.tsx");
    fs.utimesSync(settings, new Date(), new Date(Date.now() + 5000));
    expect((await get()).pages[1]).toMatchObject({
      rendered: false,
      errors: null,
    });

    // A render error, with its message; and the app failing to build.
    await call(handler, "POST", S, {
      page: "settings",
      ok: false,
      error: "Settings is not a function",
    });
    compileErrors["/src/main.tsx"] =
      'Failed to resolve import "./api" from "src/main.tsx"';
    status = await get();
    expect(status.pages[1]).toEqual({
      name: "settings",
      path: "/design/settings",
      compiled: true,
      rendered: false,
      errors: [{ error: "Settings is not a function" }],
      state: "failed",
    });

    // A page that doesn't build, known without a browser.
    compileErrors["/src/design/pages/settings.tsx"] = "Unexpected token";
    expect((await get()).pages[1]).toMatchObject({
      compiled: false,
      compileError: expect.stringContaining("Unexpected token"),
      state: "compile-error",
    });
    expect(status.app).toMatchObject({
      compiled: false,
      compileError: expect.stringContaining("Failed to resolve import"),
    });
  });

  test("a reset (a load or a hot update) clears the app's errors, for that path only", async () => {
    const { handler } = start();
    const S = "/design/__status";
    const app = async () => (await call(handler, "GET", S)).json.app;
    // Two tabs of a CRUD app on different paths.
    await call(handler, "POST", S, { app: "/orders", reset: true });
    await call(handler, "POST", S, {
      app: "/orders",
      ok: true,
      template: false,
    });
    await call(handler, "POST", S, {
      app: "/orders",
      error: "orders.map is not a function",
    });
    await call(handler, "POST", S, { app: "/orders/new", reset: true });
    await call(handler, "POST", S, {
      app: "/orders/new",
      ok: true,
      template: false,
    });
    // The last path reported is shown; the other tab didn't wipe /orders.
    expect(await app()).toMatchObject({
      path: "/orders/new",
      rendered: true,
      errors: [],
    });
    await call(handler, "POST", S, {
      app: "/orders",
      ok: true,
      template: false,
    });
    expect(await app()).toMatchObject({
      path: "/orders",
      errors: [{ error: "orders.map is not a function" }],
    });

    // The fix arrives as a hot update: /orders resets and reports again.
    await call(handler, "POST", S, { app: "/orders", reset: true });
    await call(handler, "POST", S, {
      app: "/orders",
      ok: true,
      template: false,
    });
    expect(await app()).toMatchObject({
      path: "/orders",
      rendered: true,
      errors: [],
    });
  });

  test("/design/__status answers CORS for the builder origins only", async () => {
    const { handler } = start(undefined, ["https://builder.example.com"]);
    const pre = await call(handler, "OPTIONS", "/design/__status", undefined, {
      origin: "https://builder.example.com",
    });
    expect(pre.status).toBe(204);
    expect(pre.headers["access-control-allow-origin"]).toBe(
      "https://builder.example.com",
    );
    expect(pre.headers["access-control-allow-headers"]).toBe("Content-Type");
    const other = await call(handler, "GET", "/design/__status", undefined, {
      origin: "https://evil.example.com",
    });
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
