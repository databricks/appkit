import fs from "node:fs";
import path from "node:path";

/**
 * How long a spawn lock is considered fresh. A held lock newer than this means a
 * background worker is genuinely in flight, so the foreground skips spawning;
 * older than this the lock is presumed orphaned (the worker crashed/was killed
 * before it could release) and is stolen.
 *
 * Must comfortably exceed the worker's worst-case runtime: the blocking preflight
 * wait cap (PREFLIGHT_WAIT_MAX_MS = 5 min in the type-generator) plus a DESCRIBE
 * budget. Six minutes leaves ~1 min of headroom over a worker that waits the full
 * preflight window and then describes.
 */
export const SPAWN_LOCK_STALE_MS = 6 * 60 * 1000;

/**
 * Resolve the on-disk path of the single-flight spawn lock for a project.
 *
 * Lives alongside the type-generator cache (`node_modules/.databricks/appkit/`)
 * so it shares the same already-creatable, gitignored, per-project location and
 * doesn't introduce a new directory. The lock is keyed only by project root, so
 * concurrent `generate-types` invocations for the same project (postinstall +
 * predev, say) contend for one lock and only one wins the spawn.
 *
 * @param rootDir - project root (the resolved first CLI argument / cwd).
 * @returns absolute path to the lock file.
 */
export function getSpawnLockPath(rootDir: string): string {
  return path.join(
    rootDir,
    "node_modules",
    ".databricks",
    "appkit",
    ".appkit-typegen-worker.lock",
  );
}

/**
 * Try to acquire the single-flight spawn lock.
 *
 * Atomic create via `fs.writeFileSync(lockPath, ..., { flag: "wx" })` — `wx`
 * fails (EEXIST) if the file already exists, so the create itself is the
 * mutual-exclusion primitive (no check-then-create race between two foreground
 * processes). The lock body records pid + timestamp purely for debugging.
 *
 * On EEXIST we stat the existing lock:
 *  - fresh (mtime within {@link staleMs}) → a worker is in flight, return false.
 *  - stale (mtime older than staleMs) → presumed orphaned; unlink and recreate.
 *    The recreate also uses `wx`, so if a competing process steals it first we
 *    lose the race cleanly and return false.
 *
 * Any unexpected error (permission, ENOENT on a missing parent dir we couldn't
 * create, …) is swallowed and reported as "not acquired": failing to take the
 * lock must never break the foreground — at worst we skip the background refresh.
 *
 * @param lockPath - path returned by {@link getSpawnLockPath}.
 * @param staleMs - age beyond which a held lock is stolen. Defaults to
 *   {@link SPAWN_LOCK_STALE_MS}.
 * @returns true if this caller now owns the lock (and must release it), false if
 *   another live worker holds it or the lock couldn't be taken.
 */
export function acquireSpawnLock(
  lockPath: string,
  staleMs: number = SPAWN_LOCK_STALE_MS,
): boolean {
  const body = `${process.pid} ${Date.now()}\n`;

  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  } catch {
    // Parent dir creation is best-effort; the create below will surface any real
    // problem and we'll treat it as "not acquired".
  }

  try {
    fs.writeFileSync(lockPath, body, { flag: "wx" });
    return true;
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "EEXIST") {
      // Unexpected failure — don't let lock IO break the foreground.
      return false;
    }
  }

  // Lock exists — decide fresh vs stale.
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(lockPath).mtimeMs;
  } catch {
    // It vanished between the failed create and the stat (released by the
    // worker). Try once more to take it.
    return tryCreate(lockPath, body);
  }

  if (Date.now() - mtimeMs < staleMs) {
    // A worker is genuinely in flight.
    return false;
  }

  // Stale: steal it. Unlink (ignore ENOENT — someone else may have cleaned up)
  // then re-create with `wx` so we still lose cleanly to a racing stealer.
  try {
    fs.unlinkSync(lockPath);
  } catch (error) {
    if (isErrnoException(error) && error.code !== "ENOENT") {
      return false;
    }
  }
  return tryCreate(lockPath, body);
}

/**
 * Release the spawn lock. Unlink, ignoring ENOENT (already gone — e.g. it was
 * stolen as stale by another process, or never existed). Any other error is
 * swallowed: a failed release at worst leaves a stale lock that the next caller
 * will steal after {@link SPAWN_LOCK_STALE_MS}.
 *
 * @param lockPath - path returned by {@link getSpawnLockPath}.
 */
export function releaseSpawnLock(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // ENOENT or any other error — releasing is best-effort.
  }
}

/**
 * Attempt an atomic `wx` create, returning whether it succeeded. EEXIST (a
 * racing creator beat us) and any other error map to false.
 */
function tryCreate(lockPath: string, body: string): boolean {
  try {
    fs.writeFileSync(lockPath, body, { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Narrow an unknown caught value to a Node errno exception so `.code` is safe to
 * read.
 */
function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
