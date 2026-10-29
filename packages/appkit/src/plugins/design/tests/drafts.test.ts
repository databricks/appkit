import fs from "node:fs";
import type { ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  hydratorModule,
  injectHydrator,
  listDrafts,
  normalizeBlock,
  streamDraft,
} from "../drafts";

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

  test("renders blocks while streaming and fails invalid ones once the document is done", () => {
    expect(code).toContain("new MutationObserver(() => scan(false))");
    expect(code).toContain('addEventListener("DOMContentLoaded"');
    expect(code).toContain('fail(script, new Error("invalid JSON: "');
  });

  test("reports errors as appkit:draft-error v1, only to the builder origins", () => {
    expect(code).toContain('const ORIGINS = ["https://builder.example.com"]');
    expect(code).toContain('type: "appkit:draft-error", version: 1, ...report');
    expect(code).toContain("const report = { draft: DRAFT, block:");
  });
});
