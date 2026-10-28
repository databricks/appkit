import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { createTestApp, type TestApp } from "../../../testing";
import { server } from "../../server";
import { design } from "../index";
import {
  designStatus,
  designVitePlugin,
  entryModule,
  listDesignPages,
  resolveDesignPage,
} from "../vite-plugin";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "appkit-design-"));

const PAGE = "export default function Page() { return null; }";

function clientWith(files: string[] | Record<string, string>) {
  const root = tmp();
  const entries = Array.isArray(files)
    ? files.map((f) => [f, PAGE] as const)
    : Object.entries(files);
  for (const [file, text] of entries) {
    const full = path.join(root, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  return root;
}

describe("resolveDesignPage", () => {
  const root = clientWith([
    "src/design/index.tsx",
    "src/design/pages/orders.tsx",
    "src/design/pages/legacy.jsx",
  ]);

  test("/design is the index page", () => {
    expect(resolveDesignPage(root, "/design")).toBe(
      path.join(root, "src/design/index.tsx"),
    );
    expect(resolveDesignPage(root, "/design/")).toBe(
      path.join(root, "src/design/index.tsx"),
    );
  });

  test("/design/<name> is pages/<name>", () => {
    expect(resolveDesignPage(root, "/design/orders")).toBe(
      path.join(root, "src/design/pages/orders.tsx"),
    );
    expect(resolveDesignPage(root, "/design/legacy")).toBe(
      path.join(root, "src/design/pages/legacy.jsx"),
    );
  });

  test("anything under /design that isn't a page is null (served as 404)", () => {
    expect(resolveDesignPage(clientWith([]), "/design")).toBeNull();
    for (const p of [
      "/design/missing",
      "/design/a/b",
      "/design/../secret",
      "/design/orders.tsx",
    ]) {
      expect(resolveDesignPage(root, p)).toBeNull();
    }
  });

  test('"index" and "__*" are reserved, not page names', () => {
    const r = clientWith([
      "src/design/index.tsx",
      "src/design/pages/index.tsx",
      "src/design/pages/__status.tsx",
    ]);
    expect(resolveDesignPage(r, "/design/index")).toBeNull();
    expect(resolveDesignPage(r, "/design/__status")).toBeNull();
    expect(listDesignPages(r)).toEqual([{ name: "index", path: "/design" }]);
  });

  test("paths outside /design are left alone", () => {
    for (const p of ["/", "/designer", "/api/design", "/orders"]) {
      expect(resolveDesignPage(root, p)).toBeUndefined();
    }
  });
});

describe("listDesignPages", () => {
  test("index first, then pages by name", () => {
    const root = clientWith([
      "src/design/index.tsx",
      "src/design/pages/settings.tsx",
      "src/design/pages/orders.jsx",
      "src/design/pages/notes.md",
    ]);
    expect(listDesignPages(root)).toEqual([
      { name: "index", path: "/design" },
      { name: "orders", path: "/design/orders" },
      { name: "settings", path: "/design/settings" },
    ]);
  });

  test("no design folder, no pages", () => {
    expect(listDesignPages(clientWith([]))).toEqual([]);
  });
});

describe("designStatus", () => {
  const mtime = (root: string) =>
    fs.statSync(path.join(root, "src/design/index.tsx")).mtimeMs;

  test("ready only for a real index page painted since its last change", () => {
    const root = clientWith({
      "src/design/index.tsx": PAGE,
      "src/design/pages/orders.tsx": PAGE,
    });
    expect(designStatus(root, undefined)).toEqual({
      ready: false,
      pages: [
        { name: "index", path: "/design" },
        { name: "orders", path: "/design/orders" },
      ],
    });
    expect(designStatus(root, mtime(root)).ready).toBe(true);
    // A paint of an older version of the file doesn't count.
    expect(designStatus(root, mtime(root) - 1000).ready).toBe(false);
  });

  test("never ready while index is the template placeholder", () => {
    const root = clientWith({
      "src/design/index.tsx": `export const designPlaceholder = true;\n${PAGE}`,
    });
    expect(designStatus(root, mtime(root)).ready).toBe(false);
  });

  test("never ready without an index page", () => {
    const root = clientWith(["src/design/pages/orders.tsx"]);
    expect(designStatus(root, 1)).toEqual({
      ready: false,
      pages: [{ name: "orders", path: "/design/orders" }],
    });
  });
});

describe("entryModule", () => {
  test("router mode: basename /design, other pages lazy", () => {
    const code = entryModule("pages/orders.tsx", [], true);
    expect(code).toContain(
      'import * as initial from "/src/design/pages/orders.tsx"',
    );
    expect(code).toContain(
      'createBrowserRouter(routes, { basename: "/design" })',
    );
    expect(code).toContain("lazy: async () =>");
    expect(code).not.toContain("eager: true }),");
  });

  test("routes and lists only non-reserved page files", () => {
    const code = entryModule("index.tsx", [], true);
    expect(code).toContain('"!/src/design/pages/index.{tsx,jsx}"');
    expect(code).toContain('"!/src/design/pages/__*"');
  });

  test("without react-router it renders just the page", () => {
    const code = entryModule("index.tsx", [], false);
    expect(code).not.toContain("react-router");
    expect(code).toContain('import * as initial from "/src/design/index.tsx"');
  });

  test("posts appkit:design-ready only to the configured origins", () => {
    const code = entryModule(
      "index.tsx",
      ["https://builder.example.com"],
      false,
    );
    expect(code).toContain('const ORIGINS = ["https://builder.example.com"]');
    expect(code).toContain('type: "appkit:design-ready", version: 1');
    expect(code).toContain("target.postMessage(");
    expect(code).not.toContain('"*"');
    expect(code).toContain(
      "const placeholder = mod.designPlaceholder === true",
    );
    expect(code).toContain("ok: !this.state.error && !placeholder");
    // A render error anywhere in the page's tree un-readies the server.
    expect(code).toContain("if (this.state.error) postStatus(name, false)");
  });
});

describe("builderOrigin", () => {
  const construct = (builderOrigin: string | string[]) => {
    const { plugin: DesignPlugin, config } = design({ builderOrigin });
    return new DesignPlugin(config);
  };

  test("accepts bare origins", () => {
    expect(() =>
      construct(["https://builder.example.com", "http://localhost:3000"]),
    ).not.toThrow();
  });

  test.each([
    "*",
    "https://builder.example.com/path",
    "builder.example.com",
    "null",
  ])("rejects %s", (origin) => {
    expect(() => construct(origin)).toThrow(/bare origin/);
  });
});

describe("page entry", () => {
  const load = (file: string) =>
    (designVitePlugin().load as (id: string) => string | undefined)(
      `\0virtual:appkit-design-page:${file}.mjs`,
    );

  test("statically imports only the requested page, so other drafts can't break it", () => {
    for (const [file, code] of [
      ["index.tsx", load("index.tsx")],
      ["pages/orders.jsx", load("pages/orders.jsx")],
    ] as const) {
      const staticPageImports = code?.match(
        /^import .* from "\/src\/design\/.*"/gm,
      );
      expect(staticPageImports).toEqual([
        `import * as initial from "/src/design/${file}";`.replace(/;$/, ""),
      ]);
    }
  });

  test("refuses anything that isn't a design page file", () => {
    for (const file of [
      "../main.tsx",
      "pages/a/b.tsx",
      "index.ts",
      "pages/x.css",
    ]) {
      expect(load(file)).toBeUndefined();
    }
  });
});

describe("design plugin outside development", () => {
  let app: TestApp<never> | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  function staticDir() {
    const dir = tmp();
    fs.writeFileSync(
      path.join(dir, "index.html"),
      "<html><body></body></html>",
    );
    return dir;
  }

  test("/design is 404 and nothing else is mounted", async () => {
    app = (await createTestApp({
      nodeEnv: "production",
      plugins: [server({ staticPath: staticDir(), port: 0 }), design()],
    })) as unknown as TestApp<never>;

    expect((await app.get("/design")).status).toBe(404);
    expect((await app.get("/design/orders")).status).toBe(404);
    // The SPA fallback still serves everything else.
    expect((await app.get("/anything")).status).toBe(200);
  });
});
