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
  (plugin.configureServer as (s: unknown) => void)({
    config: { root, logger: { warn } },
    watcher,
    ws: { send: (m: (typeof sent)[number]) => sent.push(m) },
    middlewares: { use() {} },
    moduleGraph: {
      getModulesByFile: () => [],
      getModuleById: async () => undefined,
    },
    reloadModule: async () => {},
  });
  return { root, watcher, sent, warn };
}

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
