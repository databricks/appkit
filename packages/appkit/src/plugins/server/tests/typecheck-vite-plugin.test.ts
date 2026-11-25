import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { typecheckPlugin } from "../typecheck-vite-plugin";

const loggerSpies = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  event: vi.fn(),
}));

vi.mock("../../../logging/logger", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../logging/logger")>();
  return { ...actual, createLogger: () => loggerSpies };
});

// Stand-in for the app's `typecheck` script: records each run, fails while a
// `fail` marker exists, and takes a while while a `slow` marker exists.
const CHECK_SCRIPT = `
const fs = require("node:fs");
fs.appendFileSync("runs.log", "run\\n");
const delay = fs.existsSync("slow") ? 1000 : 0;
setTimeout(() => {
  if (fs.existsSync("fail")) {
    console.log("client/src/App.tsx(1,7): error TS2322: Type 'string' is not assignable to type 'number'.");
    process.exit(1);
  }
}, delay);
`;

let projectRoot: string;
let plugin: ReturnType<typeof typecheckPlugin>;

function writeProject(scripts: Record<string, string>) {
  fs.writeFileSync(
    path.join(projectRoot, "package.json"),
    JSON.stringify({ name: "app", scripts }),
  );
  fs.writeFileSync(path.join(projectRoot, "check.cjs"), CHECK_SCRIPT);
}

function runs(): number {
  const log = path.join(projectRoot, "runs.log");
  return fs.existsSync(log)
    ? fs.readFileSync(log, "utf-8").split("\n").filter(Boolean).length
    : 0;
}

function startServer() {
  const watcher = Object.assign(new EventEmitter(), { add: vi.fn() });
  (plugin.configureServer as (server: unknown) => void)({ watcher });
  return watcher;
}

describe("typecheckPlugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "appkit-typecheck-"));
  });

  afterEach(() => {
    (plugin?.buildEnd as (() => void) | undefined)?.();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test("is not applied without a typecheck script", () => {
    writeProject({ dev: "tsx watch server/server.ts" });
    plugin = typecheckPlugin({ projectRoot });

    expect((plugin.apply as () => boolean)()).toBe(false);
  });

  test("logs type errors, then reports when they are fixed", async () => {
    writeProject({ typecheck: "node check.cjs" });
    fs.writeFileSync(path.join(projectRoot, "fail"), "");
    plugin = typecheckPlugin({ projectRoot });
    expect((plugin.apply as () => boolean)()).toBe(true);

    const watcher = startServer();
    expect(watcher.add).toHaveBeenCalledWith(path.join(projectRoot, "shared"));

    await vi.waitFor(() => expect(loggerSpies.error).toHaveBeenCalledTimes(1));
    expect(loggerSpies.error.mock.calls[0][1]).toContain(
      "client/src/App.tsx(1,7): error TS2322",
    );

    fs.rmSync(path.join(projectRoot, "fail"));
    watcher.emit("change", path.join(projectRoot, "client/src/App.tsx"));

    await vi.waitFor(() =>
      expect(loggerSpies.info).toHaveBeenCalledWith("No type errors."),
    );
    expect(loggerSpies.error).toHaveBeenCalledTimes(1);
  });

  test("ignores changes to non-TypeScript files", async () => {
    writeProject({ typecheck: "node check.cjs" });
    plugin = typecheckPlugin({ projectRoot });
    const watcher = startServer();
    await vi.waitFor(() => expect(loggerSpies.info).toHaveBeenCalled());

    watcher.emit("change", path.join(projectRoot, "client/src/index.css"));
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(runs()).toBe(1);
  });

  test("stops an in-flight run on close without reporting it", async () => {
    writeProject({ typecheck: "node check.cjs" });
    fs.writeFileSync(path.join(projectRoot, "fail"), "");
    fs.writeFileSync(path.join(projectRoot, "slow"), "");
    plugin = typecheckPlugin({ projectRoot });
    startServer();
    await vi.waitFor(() => expect(runs()).toBe(1));

    (plugin.buildEnd as () => void)();
    await new Promise((resolve) => setTimeout(resolve, 1500));

    expect(loggerSpies.error).not.toHaveBeenCalled();
    expect(loggerSpies.info).not.toHaveBeenCalled();
  });
});
