import fs from "node:fs";
import type { ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  dataAppkitSchema,
  hydratorModule,
  injectHydrator,
  listDrafts,
  normalizeBlock,
  streamDraft,
  themeCss,
} from "../drafts";
import { designVitePlugin } from "../vite-plugin";

describe("normalizeBlock", () => {
  test("compact chart form becomes rows with xKey / yKey", () => {
    expect(
      normalizeBlock("BarChart", {
        x: ["Jan", "Feb"],
        series: [{ name: "2026", data: [12, 19] }],
        title: "Trips",
      }),
    ).toEqual({
      component: "BarChart",
      props: {
        title: "Trips",
        data: [
          { x: "Jan", 2026: 12 },
          { x: "Feb", 2026: 19 },
        ],
        xKey: "x",
        yKey: "2026",
      },
    });
    expect(
      normalizeBlock("LineChart", {
        x: ["a"],
        series: [
          { name: "s1", data: [1] },
          { name: "s2", data: [2] },
        ],
      }).props.yKey,
    ).toEqual(["s1", "s2"]);
  });

  test("native chart props pass through", () => {
    const props = { data: [{ day: "Mon", trips: 3 }], xKey: "day" };
    expect(normalizeBlock("AreaChart", props)).toEqual({
      component: "AreaChart",
      props,
    });
  });

  test("DataTable takes column names or {key,label} and object or array rows", () => {
    expect(
      normalizeBlock("DataTable", {
        columns: ["city", { key: "n", label: "Trips" }],
        rows: [["Madrid", 3], { city: "Rome", n: 5 }],
      }).props,
    ).toEqual({
      columns: [
        { key: "city", label: "city" },
        { key: "n", label: "Trips" },
      ],
      rows: [
        { city: "Madrid", n: 3 },
        { city: "Rome", n: 5 },
      ],
    });
  });

  test("KpiCard needs a label and a value", () => {
    expect(
      normalizeBlock("KpiCard", { label: "Revenue", value: "$48k" }),
    ).toEqual({
      component: "KpiCard",
      props: { label: "Revenue", value: "$48k" },
    });
  });

  test.each([
    ["Chart", {}, /Unknown data-appkit component "Chart"/],
    ["BarChart", [], /JSON object of props/],
    ["BarChart", { title: "x" }, /needs "data" \(rows\) or "x"/],
    ["BarChart", { x: ["a"], series: [] }, /non-empty array/],
    [
      "PieChart",
      { x: ["a", "b"], series: [{ name: "s", data: [1] }] },
      /1 values for 2 x labels/,
    ],
    [
      "DataTable",
      { columns: [], rows: [] },
      /"columns" must be a non-empty array/,
    ],
    ["DataTable", { columns: ["a"], rows: [1] }, /rows\[0\]/],
    ["KpiCard", { value: 1 }, /"label" must be a string/],
  ])("%s %j is rejected", (kind, props, message) => {
    expect(() => normalizeBlock(kind, props)).toThrow(message);
  });
});

describe("dataAppkitSchema", () => {
  const { components } = dataAppkitSchema();

  test("covers exactly the components normalizeBlock accepts", () => {
    let allowed: string[] = [];
    try {
      normalizeBlock("__none__", {});
    } catch (e) {
      allowed =
        /Allowed: (.*)\.$/.exec((e as Error).message)?.[1].split(", ") ?? [];
    }
    expect(Object.keys(components).sort()).toEqual([...allowed].sort());
  });

  test.each(Object.entries(components))("%s example renders", (kind, spec) => {
    expect(() => normalizeBlock(kind, spec.example)).not.toThrow();
  });

  test.each(
    Object.entries(components).flatMap(([kind, spec]) =>
      ((spec.schema as { required?: string[] }).required ?? []).map(
        (field) => [kind, field] as const,
      ),
    ),
  )("%s without %s is rejected, as the schema says", (kind, field) => {
    const { [field]: _dropped, ...rest } = components[
      kind as keyof typeof components
    ].example as Record<string, unknown>;
    expect(() => normalizeBlock(kind, rest)).toThrow();
  });

  test("the shipped components.schema.json is up to date", () => {
    const shipped = JSON.parse(
      fs.readFileSync(
        path.join(
          import.meta.dirname,
          "../../../../../appkit-ui/src/design/components.schema.json",
        ),
        "utf-8",
      ),
    );
    // If this fails, run: pnpm exec tsx tools/generate-design-schema.ts
    expect(shipped).toEqual(dataAppkitSchema());
  });

  test("charts need either x + series or data rows", () => {
    for (const kind of [
      "BarChart",
      "LineChart",
      "AreaChart",
      "PieChart",
      "DonutChart",
    ]) {
      expect(() => normalizeBlock(kind, { title: "t" })).toThrow(
        /needs "data"/,
      );
    }
  });
});

describe("themeCss", () => {
  const css = themeCss(
    fs.readFileSync(
      path.join(
        import.meta.dirname,
        "../../../../../appkit-ui/src/react/styles/globals.css",
      ),
      "utf-8",
    ),
  );

  test("has the template's light and dark tokens, dark via prefers-color-scheme", () => {
    expect(css).toMatch(
      /:root \{\n {2}--radius: 0\.625rem;\n {2}color-scheme: light;/,
    );
    expect(css).toMatch(
      /@media \(prefers-color-scheme: dark\) \{\n {2}:root:not\(\.light\) \{\n[\s\S]*color-scheme: dark;/,
    );
    for (const token of [
      "--background",
      "--foreground",
      "--primary",
      "--chart-1",
      "--border",
    ]) {
      expect(css.split(token).length - 1).toBeGreaterThanOrEqual(3); // light, dark, .dark
    }
  });

  test("only tokens: no utilities or base rules besides the body colors", () => {
    expect(css).not.toContain("@layer");
    expect(css).not.toContain("@import");
    expect(css).toContain(":where(body) {\n  background: var(--background);");
  });
});

describe("injectHydrator", () => {
  const tag = '<script type="module" async src="/h.mjs"></script>';
  test("goes after the doctype so the page stays in standards mode", () => {
    expect(injectHydrator("<!DOCTYPE html><html>", tag)).toBe(
      `<!DOCTYPE html>${tag}<html>`,
    );
  });
  test("goes first without a doctype", () => {
    expect(injectHydrator("<div>", tag)).toBe(`${tag}<div>`);
  });
});

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "appkit-drafts-"));

describe("listDrafts", () => {
  test("lists drafts/*.html by name", () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, "drafts"));
    for (const f of ["b.html", "a.html", "index.json", "notes.md"]) {
      fs.writeFileSync(path.join(root, "drafts", f), "");
    }
    expect(listDrafts(root)).toEqual([
      { name: "a", path: "/design/drafts/a" },
      { name: "b", path: "/design/drafts/b" },
    ]);
    expect(listDrafts(tmp())).toEqual([]);
  });
});

describe("streamDraft", () => {
  function fakeResponse() {
    const chunks: string[] = [];
    let ended: () => void;
    const done = new Promise<void>((r) => (ended = r));
    const res = {
      setHeader() {},
      on() {},
      write(chunk: string) {
        chunks.push(chunk);
      },
      end(chunk?: string) {
        if (chunk) chunks.push(chunk);
        ended();
      },
    } as unknown as ServerResponse;
    return { res, chunks, done };
  }

  test("sends the draft as it's written, with the hydrator injected once", async () => {
    const file = path.join(tmp(), "d.html");
    fs.writeFileSync(file, "<!doctype html><body><p>first");
    const { res, chunks, done } = fakeResponse();
    streamDraft(file, "<script></script>", res);

    await new Promise((r) => setTimeout(r, 250));
    fs.appendFileSync(file, " é</p>");
    await new Promise((r) => setTimeout(r, 250));
    fs.appendFileSync(file, "</body></html>");
    await done;

    expect(chunks.length).toBeGreaterThan(1); // streamed, not sent at once
    expect(chunks.join("")).toBe(
      "<!doctype html><script></script><body><p>first é</p></body></html>",
    );
  });

  test(
    "ends a draft that stops changing without </html>",
    { timeout: 15000 },
    async () => {
      const file = path.join(tmp(), "d.html");
      fs.writeFileSync(file, "<p>partial");
      const { res, chunks, done } = fakeResponse();
      const started = Date.now();
      streamDraft(file, "<s></s>", res);
      await done;
      expect(Date.now() - started).toBeGreaterThanOrEqual(7900);
      expect(chunks.join("")).toBe("<s></s><p>partial");
    },
  );
});

describe("hydratorModule", () => {
  const code = hydratorModule(
    "dash",
    ["https://builder.example.com"],
    "/design/__status",
  );

  test("renders with the real appkit-ui components, no CDN", () => {
    expect(code).toContain('import("@databricks/appkit-ui/react")');
    // Fast Refresh preamble before any component module loads.
    expect(code.indexOf("injectIntoGlobalHook(window)")).toBeLessThan(
      code.indexOf('import("@databricks/appkit-ui/react")'),
    );
    expect(code).not.toMatch(/https?:\/\/(?!builder\.example\.com)/);
    expect(code).toContain("const normalizeBlock = function normalizeBlock(");
  });

  test("posts errors to this dev server's origin, without Vite's asset-URL pattern", () => {
    expect(code).toContain(
      'statusPath: new URL(import.meta.url).origin + "/design/__status"',
    );
    expect(code).not.toMatch(/new URL\([^)]*,\s*import\.meta\.url\)/);
  });

  test("is valid JavaScript", async () => {
    const { parseAst } = await import("vite");
    expect(() => parseAst(code)).not.toThrow();
  });

  test("embeds the tested runHydrator with this draft's origins", () => {
    expect(code).toContain("const runHydrator = function runHydrator(");
    expect(code).toContain('origins: ["https://builder.example.com"]');
    expect(code).toContain("draft: DRAFT");
  });
});

describe("draft errors in /design/__status", () => {
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
    fs.mkdirSync(path.join(app, "drafts"));
    fs.writeFileSync(path.join(app, "drafts", "dash.html"), "<html></html>");
    process.chdir(app);
    const plugin = designVitePlugin({ builderOrigins });
    let handler: Handler | undefined;
    (plugin.configureServer as (s: unknown) => void)({
      config: { root: path.join(app, "client") },
      watcher: { add() {}, on() {} },
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

  test("errors the hydrator POSTs are listed for the draft, and a reload resets them", async () => {
    const { handler } = start();
    const S = "/design/__status";
    await call(handler, "POST", S, { draft: "dash", reset: true });
    await call(handler, "POST", S, {
      draft: "dash",
      block: 2,
      component: "DataTable",
      error: 'DataTable: "columns" must be a non-empty array.',
    });

    const { json } = await call(handler, "GET", S);
    expect(json.drafts).toEqual([
      {
        name: "dash",
        path: "/design/drafts/dash",
        errors: [
          {
            block: 2,
            component: "DataTable",
            error: 'DataTable: "columns" must be a non-empty array.',
          },
        ],
      },
    ]);

    await call(handler, "POST", S, { draft: "dash", reset: true });
    expect((await call(handler, "GET", S)).json.drafts[0].errors).toEqual([]);
  });

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

  test("serves the hydrator at a stable URL for drafts streamed elsewhere", async () => {
    const { handler } = start();
    const r = await call(
      handler,
      "GET",
      "/design/drafts/__hydrator.js?draft=dash",
    );
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe(
      "/@id/__x00__virtual:appkit-draft-hydrator:dash.mjs",
    );
    // No (or an unsafe) name: a neutral one, never a path.
    expect(
      (await call(handler, "GET", "/design/drafts/__hydrator.js?draft=../x"))
        .headers.location,
    ).toBe("/@id/__x00__virtual:appkit-draft-hydrator:stream.mjs");
    expect((await call(handler, "GET", "/design/__status")).json.hydrator).toBe(
      "/design/drafts/__hydrator.js",
    );
  });

  test("errors of a draft streamed elsewhere (no file) are listed too", async () => {
    const { handler } = start();
    const S = "/design/__status";
    await call(handler, "POST", S, { draft: "live", reset: true });
    await call(handler, "POST", S, {
      draft: "live",
      block: 0,
      component: "Sparkline",
      error: "Unknown",
    });
    expect((await call(handler, "GET", S)).json.drafts).toContainEqual({
      name: "live",
      path: null,
      streamed: true,
      errors: [{ block: 0, component: "Sparkline", error: "Unknown" }],
    });
  });

  test("its endpoints answer CORS for the builder origins only", async () => {
    const { handler } = start(undefined, ["https://builder.example.com"]);
    const pre = await call(handler, "OPTIONS", "/design/__status", undefined, {
      origin: "https://builder.example.com",
    });
    expect(pre.status).toBe(204);
    expect(pre.headers["access-control-allow-origin"]).toBe(
      "https://builder.example.com",
    );
    expect(pre.headers["access-control-allow-headers"]).toBe("Content-Type");
    const other = await call(
      handler,
      "GET",
      "/design/drafts/__hydrator.js",
      undefined,
      {
        origin: "https://evil.example.com",
      },
    );
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
  });

  test("serves the block schema and links it from the status", async () => {
    const { handler } = start();
    const status = (await call(handler, "GET", "/design/__status")).json;
    expect(status.blockSchema).toBe("/design/__data-appkit.schema.json");
    const schema = (await call(handler, "GET", status.blockSchema)).json;
    expect(Object.keys(schema.components)).toContain("DataTable");
    expect(schema.components.DataTable.schema.properties.columns.minItems).toBe(
      1,
    );
  });

  test("errors of an older version of the draft are dropped", async () => {
    const { app, handler } = start();
    const S = "/design/__status";
    await call(handler, "POST", S, {
      draft: "dash",
      block: 0,
      component: "X",
      error: "e",
    });
    const file = path.join(app, "drafts", "dash.html");
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));
    expect((await call(handler, "GET", S)).json.drafts[0].errors).toEqual([]);
  });
});
