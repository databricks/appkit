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
    h: (
      type: unknown,
      props: Record<string, unknown>,
      ...children: unknown[]
    ) =>
      children.length
        ? { type, props: { ...props, children: children[0] } }
        : { type, props },
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
afterEach(() => {
  restore();
  delete (globalThis as { __appkitShownBlocks?: unknown }).__appkitShownBlocks;
});

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
    // A chart renders in its wrapper: [heading or null, chart box].
    const chart = t.rendered.find(Array.isArray) as unknown as [
      unknown,
      { props: { children: { type: unknown; props: unknown } } },
    ];
    expect(chart[1].props.children).toEqual({
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
    expect(
      host.shadowRoot
        .querySelector("style")
        .textContent.startsWith(
          ":host{--x:1}@media (prefers-color-scheme: dark){:host(:not(.light)){--x:2}}",
        ),
    ).toBe(true);
  });

  test("a block still streaming shows a skeleton, replaced in place when its JSON completes", () => {
    doc.body.innerHTML = "";
    const rendered: unknown[] = [];
    const { scan } = runHydrator({
      draft: "d",
      origins: [],
      statusPath: "/s",
      css: "",
      h: (type: unknown) => ({ type }),
      createRoot: () => ({ render: (n: unknown) => rendered.push(n) }),
      UI,
      normalizeBlock,
      fetch: async () => ({}),
    });
    doc.body.innerHTML =
      '<script type="application/json" data-appkit="KpiCard">{"label":"Trips","va</script>';
    scan(false);
    const host = [
      ...doc.querySelectorAll("[data-appkit-block]"),
    ][0] as unknown as {
      shadowRoot: {
        querySelector(
          s: string,
        ): { getAttribute(n: string): string | null; className: string } | null;
        querySelector(s: "style"): { textContent: string };
      };
    };
    const bone = host.shadowRoot.querySelector(".appkit-skeleton");
    expect(bone?.getAttribute("data-kind")).toBe("KpiCard");
    expect(rendered).toHaveLength(0);

    (
      doc as unknown as { querySelector(s: string): { textContent: string } }
    ).querySelector("script[data-appkit]").textContent =
      '{"label":"Trips","value":12}';
    scan(false);
    expect([...doc.querySelectorAll("[data-appkit-block]")]).toHaveLength(1); // same host
    expect(host.shadowRoot.querySelector(".appkit-skeleton")).toBeNull();
    expect(host.shadowRoot.querySelector(".appkit-fade")).not.toBeNull();
    expect(rendered).toHaveLength(1);
    // The fade and the pulse are off with prefers-reduced-motion.
    expect(host.shadowRoot.querySelector("style").textContent).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[^}]*animation: none;[^}]*\}[^}]*transition: none;/,
    );
  });

  test("exposes the theme tokens on the document root at the lowest priority", () => {
    const t = setup("");
    restore = t.restore;
    const tokens = doc.querySelector("style[data-appkit-tokens]");
    expect(tokens?.textContent?.startsWith(":where(:root){")).toBe(true);
  });

  const hydrate = (render: (n: unknown) => void = () => {}) =>
    runHydrator({
      draft: "d",
      origins: [],
      statusPath: "/s",
      css: "",
      h: (type: unknown, props: unknown, ...children: unknown[]) => ({
        type,
        props,
        children,
      }),
      createRoot: () => ({ render }),
      UI,
      normalizeBlock,
      fetch: async () => ({}),
    });
  type Host = {
    style: { height: string };
    shadowRoot: { querySelector(s: string): unknown };
  };
  const hosts = () =>
    [...doc.querySelectorAll("[data-appkit-block]")] as unknown as Host[];
  const BAR =
    '<script type="application/json" data-appkit="BarChart">{"title":"Fares","x":["a"],"series":[{"name":"s","data":[1]}]}</script>';

  test("a chart's title is a heading above the chart, not drawn inside it", () => {
    doc.body.innerHTML = BAR;
    const rendered: any[] = [];
    hydrate((n) => rendered.push(n));
    const [heading, box] = rendered[0];
    expect(heading).toMatchObject({
      type: "div",
      props: { className: "appkit-title" },
      children: ["Fares"],
    });
    const chart = box.children[0];
    expect(chart.type).toBe("BarChart");
    expect(chart.props).not.toHaveProperty("title");
  });

  test("a block fills its container only when it's all the container holds", () => {
    doc.body.innerHTML = `<div style="height:20rem">${BAR}</div><div class="card"><h2>Fares</h2>${BAR}</div>`;
    hydrate();
    expect(hosts().map((h) => h.style.height)).toEqual(["100%", ""]);
  });

  test("running again never doubles, remounts or re-fades a block", () => {
    doc.body.innerHTML = `<div>${BAR}</div>`;
    const first: unknown[] = [];
    hydrate((n) => first.push(n));
    const again: unknown[] = [];
    hydrate((n) => again.push(n));
    expect(hosts()).toHaveLength(1);
    expect(first).toHaveLength(1);
    expect(again).toHaveLength(0);

    // The same block parsed again (a fresh node, e.g. the builder re-set the
    // page): rendered, but without the fade-in.
    doc.body.innerHTML = `<div>${BAR}</div>`;
    hydrate();
    expect(hosts()[0].shadowRoot.querySelector(".appkit-root")).not.toBeNull();
    expect(hosts()[0].shadowRoot.querySelector(".appkit-fade")).toBeNull();
  });
});
