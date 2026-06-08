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
    expect(acquireSpawnLock(nested, "tok-1")).toBe(true);
    expect(fs.existsSync(nested)).toBe(true);
    // Body records pid (debugging) and the ownership token.
    const body = fs.readFileSync(nested, "utf8");
    expect(body).toContain(String(process.pid));
    expect(body).toContain("tok-1");
  });

  test("acquire returns false when a FRESH lock is already held (single-flight)", () => {
    expect(acquireSpawnLock(lockPath, "tok-a")).toBe(true);
    // Second caller sees a fresh lock and backs off.
    expect(acquireSpawnLock(lockPath, "tok-b")).toBe(false);
    // The original lock file is untouched.
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  test("acquire STEALS a stale lock (older than staleMs) and recreates it with the new token", () => {
    fs.writeFileSync(lockPath, "99999 0 old-token\n");
    // Backdate mtime well beyond the stale window.
    const old = new Date(Date.now() - (SPAWN_LOCK_STALE_MS + 60_000));
    fs.utimesSync(lockPath, old, old);

    expect(acquireSpawnLock(lockPath, "new-token")).toBe(true);
    // Re-created with our pid + token — proves it was stolen, not just observed,
    // and that the displaced owner's token no longer authorizes a release.
    const body = fs.readFileSync(lockPath, "utf8");
    expect(body).toContain(String(process.pid));
    expect(body).toContain("new-token");
    expect(body).not.toContain("old-token");
  });

  test("a custom staleMs governs the fresh/stale boundary", () => {
    fs.writeFileSync(lockPath, "1 0 held\n");
    const fiveSecAgo = new Date(Date.now() - 5_000);
    fs.utimesSync(lockPath, fiveSecAgo, fiveSecAgo);

    // 10s window: 5s-old lock is still fresh → not acquired.
    expect(acquireSpawnLock(lockPath, "tok", 10_000)).toBe(false);
    // 1s window: 5s-old lock is stale → stolen.
    expect(acquireSpawnLock(lockPath, "tok", 1_000)).toBe(true);
  });

  test("release unlinks the lock when the token matches", () => {
    acquireSpawnLock(lockPath, "tok-r");
    expect(fs.existsSync(lockPath)).toBe(true);
    releaseSpawnLock(lockPath, "tok-r");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test("release is a no-op (no throw) when the lock is already gone", () => {
    expect(() => releaseSpawnLock(lockPath, "tok")).not.toThrow();
  });

  test("release then re-acquire works (full single-flight cycle)", () => {
    expect(acquireSpawnLock(lockPath, "tok-1")).toBe(true);
    expect(acquireSpawnLock(lockPath, "tok-2")).toBe(false); // held
    releaseSpawnLock(lockPath, "tok-1");
    expect(acquireSpawnLock(lockPath, "tok-3")).toBe(true); // freed → re-acquirable
  });

  // --- F4 ownership-guard tests ---------------------------------------------

  test("release does NOT unlink when the token does not match (ownership guard)", () => {
    acquireSpawnLock(lockPath, "owner-token");
    // A caller without the right token must not be able to delete the lock.
    releaseSpawnLock(lockPath, "wrong-token");
    expect(fs.existsSync(lockPath)).toBe(true);
    // The rightful owner still can.
    releaseSpawnLock(lockPath, "owner-token");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  test("release on a foreign/arbitrary path is a no-op (the file survives)", () => {
    // A stray release must never unlink a file it doesn't own, even if the path
    // exists and the token happens to appear nowhere in it.
    const foreign = path.join(tmpRoot, "not-a-lock.txt");
    fs.writeFileSync(foreign, "important unrelated contents\n");

    releaseSpawnLock(foreign, "any-token");

    expect(fs.existsSync(foreign)).toBe(true);
    expect(fs.readFileSync(foreign, "utf8")).toBe(
      "important unrelated contents\n",
    );
  });

  test("a stale-steal then the displaced owner's release does not delete the NEW owner's lock", () => {
    // Worker A holds the lock.
    expect(acquireSpawnLock(lockPath, "token-A")).toBe(true);
    // Time passes; the lock goes stale and worker B steals it (recreates with B's
    // token). Backdate so the steal path runs.
    const old = new Date(Date.now() - (SPAWN_LOCK_STALE_MS + 60_000));
    fs.utimesSync(lockPath, old, old);
    expect(acquireSpawnLock(lockPath, "token-B")).toBe(true);

    // Worker A finally finishes and releases with ITS token — must NOT delete the
    // lock B now owns.
    releaseSpawnLock(lockPath, "token-A");
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.readFileSync(lockPath, "utf8")).toContain("token-B");

    // B's own release still works.
    releaseSpawnLock(lockPath, "token-B");
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
