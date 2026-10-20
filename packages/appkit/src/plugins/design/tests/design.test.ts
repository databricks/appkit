import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { createTestApp, type TestApp } from "../../../testing";
import { server } from "../../server";
import { design } from "../index";
import { DesignSelectionStore } from "../store";

const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "appkit-design-"));

describe("DesignSelectionStore", () => {
  test("persists selections and writes screenshots as image files", async () => {
    const root = tmp();
    const store = new DesignSelectionStore(root);

    const saved = await store.add({
      note: "make it bigger",
      elements: [
        {
          component: "Card",
          source: "client/src/design/Example.tsx:10:4",
          props: { title: "x" },
          screenshot: PIXEL,
          // unknown fields are dropped
          ...({ evil: true } as object),
        },
      ],
    });

    const file = JSON.parse(
      fs.readFileSync(
        path.join(root, ".appkit/design-selection.json"),
        "utf-8",
      ),
    );
    expect(file.selections).toHaveLength(1);
    expect(file.selections[0]).toMatchObject({
      id: saved.id,
      note: "make it bigger",
    });
    const [el] = file.selections[0].elements;
    expect(el).not.toHaveProperty("evil");
    expect(el.screenshot).toBe(`.appkit/design-screenshots/${saved.id}-0.png`);
    expect(fs.existsSync(path.join(root, el.screenshot))).toBe(true);

    // survives a "restart"
    expect(
      (await new DesignSelectionStore(root).read()).selections,
    ).toHaveLength(1);

    await store.clear();
    expect((await store.read()).selections).toEqual([]);
    expect(fs.existsSync(path.join(root, ".appkit/design-screenshots"))).toBe(
      false,
    );
  });

  test("concurrent reads never see a partially written file", async () => {
    const store = new DesignSelectionStore(tmp());
    await store.add({ elements: [{ tag: "div" }] });

    let writing = true;
    const counts: number[] = [];
    const readers = Array.from({ length: 4 }, async () => {
      while (writing) counts.push((await store.read()).selections.length);
    });
    for (let i = 0; i < 100; i++) await store.add({ elements: [{ tag: "p" }] });
    writing = false;
    await Promise.all(readers);

    expect(counts.length).toBeGreaterThan(0);
    expect(counts.every((n) => n >= 1)).toBe(true);
    expect((await store.read()).selections).toHaveLength(101);
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

  test("/design is 404 and no selection API is mounted", async () => {
    app = (await createTestApp({
      nodeEnv: "production",
      plugins: [server({ staticPath: staticDir(), port: 0 }), design()],
    })) as unknown as TestApp<never>;

    expect((await app.get("/design")).status).toBe(404);
    expect((await app.get("/design/")).status).toBe(404);
    expect((await app.get("/api/design/selection")).status).not.toBe(200);
    // The SPA fallback still serves everything else.
    expect((await app.get("/anything")).status).toBe(200);
  });
});
