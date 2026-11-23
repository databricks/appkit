import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { designVitePlugin } from "../vite-plugin";

const cwd = process.cwd();
afterEach(() => process.chdir(cwd));

/** The plugin on a fake dev server whose watcher the test drives. */
function start(compilerOptions = {}) {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), "design-stream-"));
  const root = path.join(app, "client");
  fs.mkdirSync(path.join(root, "src/design/.staging"), { recursive: true });
  fs.mkdirSync(path.join(root, "src/design/pages"), { recursive: true });
  // The app's own tsconfig decides what a page imports once compiled.
  fs.writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions }),
  );
  process.chdir(app);
  const plugin = designVitePlugin();
  (plugin.configResolved as (c: { root: string }) => void)({ root });
  const watcher = new EventEmitter();
  const sent: { event: string; data: { name: string; done?: boolean } }[] = [];
  const warn = vi.fn();
  // Modules the browser has loaded, by file, and the ones hot-updated since.
  const modules = new Map<string, object[]>();
  const reloaded: object[] = [];
  let handler: Handler | undefined;
  (plugin.configureServer as (s: unknown) => void)({
    config: { root, logger: { warn } },
    watcher,
    ws: { send: (m: (typeof sent)[number]) => sent.push(m) },
    middlewares: { use: (h: Handler) => (handler = h) },
    transformIndexHtml: async (_url: string, html: string) => html,
    moduleGraph: {
      getModulesByFile: (file: string) => modules.get(file) ?? [],
      getModuleById: async () => undefined,
    },
    reloadModule: async (mod: object) => {
      reloaded.push(mod);
    },
  });
  /** The HTML of `/design/__stream/<name>`. */
  const streamHtml = async (name: string) => {
    let html = "";
    await (handler as Handler)(
      { url: `/design/__stream/${name}`, headers: {} },
      { setHeader() {}, end: (b: string) => (html = b) },
      () => {},
    );
    return html;
  };
  /** What the plugin's hotUpdate leaves of Vite's update of `file`. */
  const hotUpdate = (file: string, mods: object[]) =>
    (
      plugin.hotUpdate as (o: {
        type: string;
        file: string;
        modules: object[];
        read: () => string;
      }) => Promise<object[] | undefined>
    ).call(
      {},
      {
        type: "create",
        file,
        modules: mods,
        read: () => fs.readFileSync(file, "utf-8"),
      },
    );
  return {
    root,
    watcher,
    sent,
    warn,
    streamHtml,
    modules,
    reloaded,
    hotUpdate,
  };
}

type Handler = (
  req: { url: string; headers: object },
  res: { setHeader(k: string, v: string): void; end(b: string): void },
  next: () => void,
) => Promise<void>;

const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++)
    await new Promise((r) => setTimeout(r, 20));
};

test("a staging write is published, and a finished file deleted before it's read is ignored", async () => {
  const { root, watcher, sent, warn } = start();
  const staging = path.join(root, "src/design/.staging/dash.tsx");
  fs.writeFileSync(
    staging,
    'export default function Page() {\n  return <h1 className="p-6">Trips</h1>;\n}\n',
  );
  watcher.emit("change", staging);
  await until(() => sent.some((m) => m.data?.name === "dash"));
  expect(sent.find((m) => m.data?.name === "dash")?.event).toBe(
    "appkit:stream",
  );

  // The builder writes the finished file and deletes it again (starting over)
  // before the plugin reads it: no unhandled rejection, no crash.
  watcher.emit("add", path.join(root, "src/design/pages/dash.tsx"));
  watcher.emit("add", path.join(root, "src/design/mock.ts"));
  await new Promise((r) => setTimeout(r, 100));
  expect(sent.some((m) => m.data?.done)).toBe(false);
  expect(warn).not.toHaveBeenCalled();
});

test("the stream page says whether a version is out, so a failed import isn't taken for pending", async () => {
  const { root, watcher, sent, streamHtml } = start();
  expect(await streamHtml("dash")).toContain('<div id="root"></div>');

  const staging = path.join(root, "src/design/.staging/dash.tsx");
  fs.writeFileSync(
    staging,
    "export default function Page() {\n  return <h1>Trips</h1>;\n}\n",
  );
  watcher.emit("change", staging);
  await until(() => sent.some((m) => m.data?.name === "dash"));
  expect(await streamHtml("dash")).toContain(
    '<div id="root" data-published></div>',
  );
});

const TYPES_PAGE =
  'import { type Trip } from "../mock";\n\nexport default function Page() {\n  const trip: Trip | null = null;\n  return <h1>Trips {String(trip)}</h1>;\n}\n';
const MOCK_PAGE =
  'import { trips } from "../mock";\n\nexport default function Page() {\n  return <h1>{trips.length} trips</h1>;\n}\n';
const published = (
  sent: { data: { name: string; done?: boolean } }[],
  name = "dash",
) => sent.filter((m) => m.data?.name === name);

test("a page that imports ../mock is published only once mock.ts exists", async () => {
  const { root, watcher, sent, streamHtml } = start();
  const staging = path.join(root, "src/design/.staging/dash.tsx");
  fs.writeFileSync(staging, MOCK_PAGE);
  watcher.emit("change", staging);
  // Type-only imports compile away: it doesn't wait, it's published as before.
  const types = path.join(root, "src/design/.staging/types.tsx");
  fs.writeFileSync(types, TYPES_PAGE);
  watcher.emit("change", types);
  await until(() => sent.some((m) => m.data?.name === "types"));
  expect(sent.some((m) => m.data?.name === "types")).toBe(true);
  await new Promise((r) => setTimeout(r, 200));
  expect(published(sent)).toEqual([]);
  expect(await streamHtml("dash")).toContain('<div id="root"></div>');

  const mock = path.join(root, "src/design/mock.ts");
  fs.writeFileSync(mock, "export const trips = [{ id: 1 }];\n");
  watcher.emit("add", mock);
  await until(() => published(sent).length > 0);
  expect(published(sent)).toMatchObject([
    { event: "appkit:stream", data: { name: "dash" } },
  ]);
  expect(await streamHtml("dash")).toContain(
    '<div id="root" data-published></div>',
  );
});

test("a finished page waits for mock.ts too, also when its draft was moved in", async () => {
  const { root, watcher, sent, streamHtml } = start();
  const staging = path.join(root, "src/design/.staging/dash.tsx");
  fs.writeFileSync(staging, MOCK_PAGE);
  watcher.emit("change", staging);
  await new Promise((r) => setTimeout(r, 200));
  // Moved in: the staging file goes, the finished page lands.
  fs.rmSync(staging);
  watcher.emit("unlink", staging);
  const page = path.join(root, "src/design/pages/dash.tsx");
  fs.writeFileSync(page, MOCK_PAGE);
  watcher.emit("add", page);
  await new Promise((r) => setTimeout(r, 200));
  expect(published(sent)).toEqual([]);
  expect(await streamHtml("dash")).toContain('<div id="root"></div>');

  const mock = path.join(root, "src/design/mock.ts");
  fs.writeFileSync(mock, "export const trips = [{ id: 1 }];\n");
  watcher.emit("add", mock);
  await until(() => published(sent).length > 0);
  expect(published(sent)).toMatchObject([
    { data: { name: "dash", done: true } },
  ]);
  expect(await streamHtml("dash")).toContain(
    '<div id="root" data-published></div>',
  );
});

test("with verbatimModuleSyntax, an inline type import keeps ../mock, so the page waits", async () => {
  const { root, watcher, sent } = start({ verbatimModuleSyntax: true });
  const staging = path.join(root, "src/design/.staging/dash.tsx");
  fs.writeFileSync(staging, TYPES_PAGE);
  watcher.emit("change", staging);
  await new Promise((r) => setTimeout(r, 300));
  expect(published(sent)).toEqual([]);

  const mock = path.join(root, "src/design/mock.ts");
  fs.writeFileSync(mock, "export type Trip = { id: number };\n");
  watcher.emit("add", mock);
  await until(() => published(sent).length > 0);
  expect(published(sent)).toMatchObject([{ data: { name: "dash" } }]);
});

test("a finished page shown in an earlier version gets its hot update once mock.ts lands", async () => {
  const { root, watcher, sent, modules, reloaded, hotUpdate } = start();
  // An early cut doesn't use the mock yet: its import compiles away, it's published.
  const staging = path.join(root, "src/design/.staging/dash.tsx");
  fs.writeFileSync(
    staging,
    'import { trips } from "../mock";\n\nexport default function Page() {\n  return <h1>Trips</h1>;\n}\n',
  );
  watcher.emit("change", staging);
  await until(() => published(sent).length > 0);
  expect(published(sent)).toHaveLength(1);

  // The browser has that version; the finished page, which uses the mock, lands.
  const page = path.join(root, "src/design/pages/dash.tsx");
  const mod = { importers: new Set(), isSelfAccepting: true };
  modules.set(page, [mod]);
  fs.writeFileSync(page, MOCK_PAGE);
  // Vite's update would fail without mock.ts: it's held, and so is done.
  expect(await hotUpdate(page, [mod])).toEqual([]);
  watcher.emit("add", page);
  await new Promise((r) => setTimeout(r, 200));
  expect(published(sent)).toHaveLength(1);
  expect(reloaded).toEqual([]);

  const mock = path.join(root, "src/design/mock.ts");
  fs.writeFileSync(mock, "export const trips = [{ id: 1 }];\n");
  watcher.emit("add", mock);
  await until(() => published(sent).length > 1);
  expect(reloaded).toEqual([mod]);
  expect(published(sent)[1]).toMatchObject({
    data: { name: "dash", done: true },
  });
  // With mock.ts there, Vite's own update of the page goes through.
  expect(await hotUpdate(page, [mod])).toBeUndefined();
});

test("a finished page never streamed, first seen by its stream page, is published when mock.ts lands", async () => {
  const { root, watcher, sent, streamHtml } = start();
  // No staging draft and no watcher event: only the stream page is opened.
  fs.writeFileSync(path.join(root, "src/design/pages/dash.tsx"), MOCK_PAGE);
  expect(await streamHtml("dash")).toContain('<div id="root"></div>');

  const mock = path.join(root, "src/design/mock.ts");
  fs.writeFileSync(mock, "export const trips = [{ id: 1 }];\n");
  watcher.emit("add", mock);
  await until(() => published(sent).length > 0);
  expect(published(sent)).toMatchObject([
    { data: { name: "dash", done: true } },
  ]);
  expect(await streamHtml("dash")).toContain(
    '<div id="root" data-published></div>',
  );
});

test("a finished page first seen as a hot update is updated when mock.ts lands", async () => {
  const { root, watcher, sent, modules, reloaded, hotUpdate } = start();
  // A page shown at /design/kpis (never streamed) starts using the mock.
  const page = path.join(root, "src/design/pages/kpis.tsx");
  const mod = { importers: new Set([{}]), isSelfAccepting: true };
  modules.set(page, [mod]);
  fs.writeFileSync(page, MOCK_PAGE);
  expect(await hotUpdate(page, [mod])).toEqual([]);

  const mock = path.join(root, "src/design/mock.ts");
  fs.writeFileSync(mock, "export const trips = [{ id: 1 }];\n");
  watcher.emit("add", mock);
  await until(() => published(sent, "kpis").length > 0);
  expect(reloaded).toEqual([mod]);
  expect(published(sent, "kpis")).toMatchObject([
    { data: { name: "kpis", done: true } },
  ]);
});
