import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  acquireSpawnLock,
  getSpawnLockPath,
  releaseSpawnLock,
  SPAWN_LOCK_STALE_MS,
} from "./spawn-lock";

describe("spawn-lock", () => {
  let tmpRoot: string;
  let lockPath: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "spawnlock-"));
    lockPath = path.join(tmpRoot, "worker.lock");
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("getSpawnLockPath nests under node_modules/.databricks/appkit of the root", () => {
    const root = path.join(os.tmpdir(), "some-project");
    expect(getSpawnLockPath(root)).toBe(
      path.join(
        root,
        "node_modules",
        ".databricks",
        "appkit",
        ".appkit-typegen-worker.lock",
      ),
    );
  });

  test("acquire creates the lock (and its parent dirs) and returns true", () => {
    const nested = path.join(tmpRoot, "node_modules", ".databricks", "lock");
    expect(acquireSpawnLock(nested)).toBe(true);
    expect(fs.existsSync(nested)).toBe(true);
    // Body records pid for debugging.
    expect(fs.readFileSync(nested, "utf8")).toContain(String(process.pid));
  });

  test("acquire returns false when a FRESH lock is already held (single-flight)", () => {
    expect(acquireSpawnLock(lockPath)).toBe(true);
    // Second caller sees a fresh lock and backs off.
    expect(acquireSpawnLock(lockPath)).toBe(false);
    // The original lock file is untouched.
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  test("acquire STEALS a stale lock (older than staleMs) and recreates it", () => {
    fs.writeFileSync(lockPath, "99999 0\n");
    // Backdate mtime well beyond the stale window.
    const old = new Date(Date.now() - (SPAWN_LOCK_STALE_MS + 60_000));
    fs.utimesSync(lockPath, old, old);

    expect(acquireSpawnLock(lockPath)).toBe(true);
    // Re-created with our pid — proves it was stolen, not just observed.
    expect(fs.readFileSync(lockPath, "utf8")).toContain(String(process.pid));
  });

  test("a custom staleMs governs the fresh/stale boundary", () => {
    fs.writeFileSync(lockPath, "1 0\n");
    const fiveSecAgo = new Date(Date.now() - 5_000);
    fs.utimesSync(lockPath, fiveSecAgo, fiveSecAgo);

    // 10s window: 5s-old lock is still fresh → not acquired.
    expect(acquireSpawnLock(lockPath, 10_000)).toBe(false);
    // 1s window: 5s-old lock is stale → stolen.
    expect(acquireSpawnLock(lockPath, 1_000)).toBe(true);
  });

  test("release unlinks the lock", () => {
    acquireSpawnLock(lockPath);
    expect(fs.existsSync(lockPath)).toBe(true);
    releaseSpawnLock(lockPath);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test("release is a no-op (no throw) when the lock is already gone", () => {
    expect(() => releaseSpawnLock(lockPath)).not.toThrow();
  });

  test("release then re-acquire works (full single-flight cycle)", () => {
    expect(acquireSpawnLock(lockPath)).toBe(true);
    expect(acquireSpawnLock(lockPath)).toBe(false); // held
    releaseSpawnLock(lockPath);
    expect(acquireSpawnLock(lockPath)).toBe(true); // freed → re-acquirable
  });
});
