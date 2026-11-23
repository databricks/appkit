import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test, vi } from "vitest";

import { designVitePlugin } from "../vite-plugin";

const cwd = process.cwd();
afterEach(() => process.chdir(cwd));

/** The plugin on a fake dev server whose watcher the test drives. */
function start() {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), "design-stream-"));
  const root = path.join(app, "client");
  fs.mkdirSync(path.join(root, "src/design/.staging"), { recursive: true });
  fs.mkdirSync(path.join(root, "src/design/pages"), { recursive: true });
  process.chdir(app);
  const plugin = designVitePlugin();
  (plugin.configResolved as (c: { root: string }) => void)({ root });
  const watcher = new EventEmitter();
  const sent: { event: string; data: { name: string; done?: boolean } }[] = [];
  const warn = vi.fn();
  let handler: Handler | undefined;
  (plugin.configureServer as (s: unknown) => void)({
    config: { root, logger: { warn } },
    watcher,
    ws: { send: (m: (typeof sent)[number]) => sent.push(m) },
    middlewares: { use: (h: Handler) => (handler = h) },
    transformIndexHtml: async (_url: string, html: string) => html,
    moduleGraph: {
      getModulesByFile: () => [],
      getModuleById: async () => undefined,
    },
    reloadModule: async () => {},
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
  return { root, watcher, sent, warn, streamHtml };
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

const MOCK_PAGE =
  'import { trips } from "../mock";\n\nexport default function Page() {\n  return <h1>{trips.length} trips</h1>;\n}\n';
const published = (sent: { data: { name: string; done?: boolean } }[]) =>
  sent.filter((m) => m.data?.name === "dash");

test("a page that imports ../mock is published only once mock.ts exists", async () => {
  const { root, watcher, sent, streamHtml } = start();
  const staging = path.join(root, "src/design/.staging/dash.tsx");
  fs.writeFileSync(staging, MOCK_PAGE);
  watcher.emit("change", staging);
  // Type-only imports don't wait: it's published as before.
  const types = path.join(root, "src/design/.staging/types.tsx");
  fs.writeFileSync(
    types,
    'import type { Trip } from "../mock";\n\nexport default function Page() {\n  return <h1>Trips</h1>;\n}\n',
  );
  watcher.emit("change", types);
  await until(() => sent.some((m) => m.data?.name === "types"));
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
