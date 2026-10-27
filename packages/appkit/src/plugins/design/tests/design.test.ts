import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { createTestApp, type TestApp } from "../../../testing";
import { server } from "../../server";
import { design } from "../index";
import { designVitePlugin, resolveDesignPage } from "../vite-plugin";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "appkit-design-"));

function clientWith(files: string[]) {
  const root = tmp();
  for (const file of files) {
    const full = path.join(root, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, "export default function Page() { return null; }");
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

  test("paths outside /design are left alone", () => {
    for (const p of ["/", "/designer", "/api/design", "/orders"]) {
      expect(resolveDesignPage(root, p)).toBeUndefined();
    }
  });
});

describe("page entry", () => {
  const load = (file: string) =>
    (designVitePlugin().load as (id: string) => string | undefined)(
      `\0virtual:appkit-design-page:${file}`,
    );

  test("imports only the requested page, so other drafts can't break it", () => {
    const index = load("index.tsx");
    expect(index).toContain('import Page from "/src/design/index.tsx"');
    expect(index).not.toContain("pages/");
    expect(load("pages/orders.jsx")).toContain(
      'import Page from "/src/design/pages/orders.jsx"',
    );
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
