import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type Mock,
  test,
  vi,
} from "vitest";

// --- Module mocks -----------------------------------------------------------
// vi.mock factories are hoisted above the file, so the spies they return must be
// created in a hoisted block too (plain top-level consts would be in the TDZ when
// the hoisted factory runs).
const {
  generateFromEntryPoint,
  generateServingTypes,
  unref,
  spawn,
  acquireSpawnLock,
  releaseSpawnLock,
  getSpawnLockPath,
} = vi.hoisted(() => {
  // `path` import isn't available yet inside a hoisted block; require it here.
  const nodePath = require("node:path") as typeof import("node:path");
  const unref = vi.fn();
  const lockPathOf = (root: string) =>
    nodePath.join(root, "node_modules", ".databricks", "appkit", "worker.lock");
  return {
    generateFromEntryPoint: vi.fn(async () => {}),
    generateServingTypes: vi.fn(async () => {}),
    unref,
    spawn: vi.fn(
      (_bin: string, _args: string[], _opts: Record<string, unknown>) => ({
        unref,
      }),
    ),
    acquireSpawnLock: vi.fn(() => true),
    releaseSpawnLock: vi.fn(),
    getSpawnLockPath: vi.fn(lockPathOf),
  };
});

// The library type-generator is an optional/ambient module; mock it so the
// command's `await import("@databricks/appkit/type-generator")` resolves to spies
// and never touches a warehouse.
vi.mock("@databricks/appkit/type-generator", () => ({
  generateFromEntryPoint,
  generateServingTypes,
}));

// Mock the detached spawn so we can assert how the worker is launched without
// actually forking a process.
vi.mock("node:child_process", () => ({ spawn }));

// Mock the single-flight lock so each test controls acquire/steal outcomes and
// we can assert release. Steal/fresh semantics of the real implementation are
// covered separately in spawn-lock.test.ts.
vi.mock("./spawn-lock.js", () => ({
  acquireSpawnLock,
  releaseSpawnLock,
  getSpawnLockPath,
  SPAWN_LOCK_STALE_MS: 360_000,
}));

import { generateTypesCommand, resolveTypegenMode } from "./generate-types";

/**
 * Drive the real commander command the way the bin does, so argv parsing
 * (`--block`, `--worker-lock <path>` → camelCase, positionals) is exercised
 * end-to-end. `from: "user"` means args are the user-supplied tokens only.
 */
async function runCli(args: string[]): Promise<void> {
  await generateTypesCommand.parseAsync(args, { from: "user" });
}

describe("resolveTypegenMode (generate-types --block)", () => {
  test("defaults to non-blocking when no options/flag are given", () => {
    // A one-shot CLI never describes by default — it emits cached/`unknown` types
    // and exits 0 instead of blocking on (or failing because of) a warehouse,
    // even a RUNNING one. The template's postinstall/predev rely on this.
    expect(resolveTypegenMode()).toBe("non-blocking");
    expect(resolveTypegenMode({})).toBe("non-blocking");
  });

  test("stays non-blocking when block is false (flag absent)", () => {
    expect(resolveTypegenMode({ block: false })).toBe("non-blocking");
  });

  test("switches to blocking when --block sets block to true", () => {
    // commander maps `--block` to `{ block: true }`. A deliberate/CI invocation
    // opts in to waiting for a starting warehouse and failing fast on a stopped
    // one.
    expect(resolveTypegenMode({ block: true })).toBe("blocking");
  });
});

describe("generate-types foreground spawn orchestration", () => {
  let tmpRoot: string;
  let consoleLog: Mock;
  let consoleError: Mock;
  const prevWarehouse = process.env.DATABRICKS_WAREHOUSE_ID;

  beforeEach(() => {
    vi.clearAllMocks();
    acquireSpawnLock.mockReturnValue(true);

    // A real temp project root with a config/queries folder so the analytics
    // generate path runs.
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gentypes-"));
    fs.mkdirSync(path.join(tmpRoot, "config", "queries"), { recursive: true });
    process.env.DATABRICKS_WAREHOUSE_ID = "wh-123";

    consoleLog = vi.spyOn(console, "log").mockImplementation(() => {}) as Mock;
    consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {}) as Mock;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    if (prevWarehouse === undefined) {
      delete process.env.DATABRICKS_WAREHOUSE_ID;
    } else {
      process.env.DATABRICKS_WAREHOUSE_ID = prevWarehouse;
    }
  });

  test("non-blocking: generates degraded types and spawns exactly one detached worker", async () => {
    const outFile = path.join(tmpRoot, "shared/appkit-types/analytics.d.ts");

    await runCli([tmpRoot, outFile, "wh-123"]);

    // Library generate ran in non-blocking mode (writes degraded types).
    expect(generateFromEntryPoint).toHaveBeenCalledTimes(1);
    expect(generateFromEntryPoint).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "non-blocking" }),
    );

    // Exactly one detached worker, re-invoking this CLI with --block and the
    // worker lock, forwarding the same positional targets.
    expect(spawn).toHaveBeenCalledTimes(1);
    const [bin, argv, opts] = spawn.mock.calls[0];
    expect(bin).toBe(process.execPath);
    expect(argv[0]).toBe(process.argv[1]); // CLI entry
    expect(argv.slice(1)).toEqual([
      "generate-types",
      "--block",
      "--worker-lock",
      getSpawnLockPath(tmpRoot),
      tmpRoot,
      outFile,
      "wh-123",
    ]);
    expect(opts).toMatchObject({ detached: true, stdio: "ignore" });
    expect(unref).toHaveBeenCalledTimes(1);
  });

  test("lock already held (fresh): does NOT spawn, foreground still resolves", async () => {
    acquireSpawnLock.mockReturnValue(false);

    await expect(runCli([tmpRoot])).resolves.toBeUndefined();

    expect(generateFromEntryPoint).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled();
    // One-line single-flight note.
    expect(consoleLog).toHaveBeenCalledWith(
      "Type refresh already in progress, skipping.",
    );
  });

  test("stale lock: steals (acquire returns true) and spawns", async () => {
    // acquireSpawnLock returning true models a stolen stale lock (the real steal
    // path is unit-tested in spawn-lock.test.ts).
    acquireSpawnLock.mockReturnValue(true);

    await runCli([tmpRoot]);

    expect(acquireSpawnLock).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  test("spawn throwing is non-fatal: foreground does not reject", async () => {
    spawn.mockImplementationOnce(() => {
      throw new Error("EAGAIN");
    });

    await expect(runCli([tmpRoot])).resolves.toBeUndefined();

    // Generate still ran; failure was swallowed and logged.
    expect(generateFromEntryPoint).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("Could not start background type refresh"),
    );
  });

  test("--block (deliberate/CI) generates blocking and never spawns", async () => {
    await runCli([tmpRoot, "--block"]);

    expect(generateFromEntryPoint).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "blocking" }),
    );
    expect(acquireSpawnLock).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  test("worker invocation (--worker-lock): runs blocking generate, releases lock, does NOT spawn", async () => {
    const lockPath = getSpawnLockPath(tmpRoot);

    await runCli([tmpRoot, "--worker-lock", lockPath]);

    // A worker is always blocking — it does the real DESCRIBE lifecycle.
    expect(generateFromEntryPoint).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "blocking" }),
    );
    // It releases the SAME lock it was handed.
    expect(releaseSpawnLock).toHaveBeenCalledWith(lockPath);
    // It must never spawn another worker (recursion would never terminate).
    expect(spawn).not.toHaveBeenCalled();
    expect(acquireSpawnLock).not.toHaveBeenCalled();
  });
});
