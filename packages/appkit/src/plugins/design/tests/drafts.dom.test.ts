// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";

import { normalizeBlock, runHydrator } from "../drafts";

// jsdom globals; this package compiles without the DOM typings.
const win = globalThis as unknown as {
  document: {
    body: { innerHTML: string };
    querySelector(s: string): { textContent: string | null } | null;
    querySelectorAll(
      s: string,
    ): Iterable<{ getAttribute(n: string): string | null }>;
  };
};
const doc = win.document;

const UI = Object.fromEntries(
  [
    "Card",
    "CardHeader",
    "CardDescription",
    "CardTitle",
    "CardContent",
    "Table",
    "TableHeader",
    "TableRow",
    "TableHead",
    "TableBody",
    "TableCell",
    "BarChart",
  ].map((name) => [name, name]),
);

function setup(html: string) {
  doc.body.innerHTML = html;
  const postMessage = vi.fn();
  const parent = Object.getOwnPropertyDescriptor(win, "parent");
  Object.defineProperty(win, "parent", {
    configurable: true,
    value: { postMessage },
  });
  const fetch = vi.fn(async () => ({}));
  const rendered: { type: unknown; props: Record<string, unknown> }[] = [];
  runHydrator({
    draft: "dash",
    origins: ["https://builder.example.com"],
    statusPath: "/design/__status",
    css: ":root { --chart-1: red; }",
    h: (type: unknown, props: Record<string, unknown>) => ({ type, props }),
    createRoot: () => ({
      render: (node: unknown) =>
        rendered.push(node as (typeof rendered)[number]),
    }),
    UI,
    normalizeBlock,
    fetch,
  });
  const restore = () => {
    if (parent) Object.defineProperty(win, "parent", parent);
  };
  return { postMessage, fetch, rendered, restore };
}

let restore = () => {};
afterEach(() => restore());

const BLOCKS = `
  <script type="application/json" data-appkit="KpiCard">{"label":"Trips","value":12}</script>
  <script type="application/json" data-appkit="Sparkline">{"data":[1]}</script>
  <script type="application/json" data-appkit="LineChart">{"x":["a"],"series":[</script>
  <script type="application/json" data-appkit="BarChart">{"x":["a"],"series":[{"name":"s","data":[1]}]}</script>
`;

describe("runHydrator", () => {
  test("sends every block that can't render to the builder as appkit:draft-error v1", () => {
    const t = setup(BLOCKS);
    restore = t.restore;

    expect(t.postMessage).toHaveBeenCalledTimes(2);
    expect(t.postMessage).toHaveBeenCalledWith(
      {
        type: "appkit:draft-error",
        version: 1,
        draft: "dash",
        block: 1,
        component: "Sparkline",
        error: expect.stringContaining(
          'Unknown data-appkit component "Sparkline"',
        ),
      },
      "https://builder.example.com",
    );
    expect(t.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "appkit:draft-error",
        block: 2,
        component: "LineChart",
        error: expect.stringMatching(/^invalid JSON: /),
      }),
      "https://builder.example.com",
    );
  });

  test("reports them to /design/__status, after resetting this draft's earlier errors", () => {
    const t = setup(BLOCKS);
    restore = t.restore;

    const bodies = t.fetch.mock.calls.map((c) => {
      const [url, init] = c as unknown as [string, { body: string }];
      expect(url).toBe("/design/__status");
      return JSON.parse(init.body);
    });
    expect(bodies[0]).toEqual({ draft: "dash", reset: true });
    expect(bodies.slice(1)).toEqual([
      expect.objectContaining({
        draft: "dash",
        block: 1,
        component: "Sparkline",
      }),
      expect.objectContaining({
        draft: "dash",
        block: 2,
        component: "LineChart",
      }),
    ]);
  });

  test("renders the valid blocks and shows a placeholder for the others", () => {
    const t = setup(BLOCKS);
    restore = t.restore;

    const hosts = [...doc.querySelectorAll("[data-appkit-block]")].map((h) =>
      h.getAttribute("data-appkit-block"),
    );
    expect(hosts).toEqual(["KpiCard", "Sparkline", "LineChart", "BarChart"]);
    const placeholders = t.rendered.filter(
      (n) => "data-appkit-error" in (n.props ?? {}),
    );
    expect(placeholders).toHaveLength(2);
    expect(t.rendered).toContainEqual({
      type: "BarChart",
      props: expect.objectContaining({ xKey: "x", yKey: "s" }),
    });
  });

  test("never posts without a builder win", () => {
    doc.body.innerHTML = BLOCKS;
    const fetch = vi.fn(async () => ({}));
    expect(() =>
      runHydrator({
        draft: "dash",
        origins: [],
        statusPath: "/design/__status",
        css: "",
        h: () => null,
        createRoot: () => ({ render() {} }),
        UI,
        normalizeBlock,
        fetch,
      }),
    ).not.toThrow();
    // The status endpoint still gets the errors.
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  test("scopes compound :root selectors as valid :host() selectors", () => {
    doc.body.innerHTML =
      '<script type="application/json" data-appkit="KpiCard">{"label":"a","value":1}</script>';
    runHydrator({
      draft: "d",
      origins: [],
      statusPath: "/s",
      css: ":root{--x:1}@media (prefers-color-scheme: dark){:root:not(.light){--x:2}}",
      h: () => null,
      createRoot: () => ({ render() {} }),
      UI,
      normalizeBlock,
      fetch: async () => ({}),
    });
    const host = [
      ...doc.querySelectorAll("[data-appkit-block]"),
    ][0] as unknown as {
      shadowRoot: { querySelector(s: string): { textContent: string } };
    };
    expect(host.shadowRoot.querySelector("style").textContent).toBe(
      ":host{--x:1}@media (prefers-color-scheme: dark){:host(:not(.light)){--x:2}}",
    );
  });

  test("exposes the theme tokens on the document root at the lowest priority", () => {
    const t = setup("");
    restore = t.restore;
    const tokens = doc.querySelector("style[data-appkit-tokens]");
    expect(tokens?.textContent?.startsWith(":where(:root){")).toBe(true);
  });
});
