import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { migrationsFolder } from "../migrations/paths";

declare const held: unique symbol;

/**
 * Proof that the caller owns a checkout's migration history, from
 * withHistoryLock until its callback settles. Only withHistoryLock makes one.
 */
export interface HistoryLock {
  readonly [held]: true;
  /** The checkout's migrations folder, the one this lock lets the caller write. */
  readonly folder: string;
  /** Throws once withHistoryLock's callback has settled. */
  assertHeld(): void;
}

/** The lock file's contents: who holds it, and the token only that holder knows. */
interface LockOwner {
  readonly pid: number;
  readonly host: string;
  readonly command: string;
  readonly startedAt: string;
  readonly token: string;
}

const LOCK_FILE = ".appkit-db.lock";

function readOwner(file: string): Partial<LockOwner> | null {
  try {
    const owner: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
    return typeof owner === "object" && owner !== null
      ? (owner as Partial<LockOwner>)
      : null;
  } catch {
    return null;
  }
}

/** Whether a process with this pid runs on this host; EPERM means it runs as another user. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function heldError(root: string, file: string): Error {
  const relative = path.relative(root, file);
  const owner = readOwner(file);
  const recovery = `Make sure no appkit db command runs in this checkout, delete ${relative}, then rerun.`;
  if (
    typeof owner?.pid !== "number" ||
    typeof owner.command !== "string" ||
    owner.host !== os.hostname()
  ) {
    return new Error(
      `${relative} says another appkit db command${typeof owner?.host === "string" ? ` on ${owner.host}` : ""} is changing the migration history. ${recovery}`,
    );
  }
  if (!isRunning(owner.pid)) {
    return new Error(
      `\`appkit db ${owner.command}\` (pid ${owner.pid}) stopped without releasing ${relative}. ${recovery}`,
    );
  }
  return new Error(
    `Another \`appkit db ${owner.command}\` (pid ${owner.pid} on ${owner.host}, since ${owner.startedAt}) is changing the migration history in ${path.dirname(relative)}. Wait for it to finish, then rerun. If pid ${owner.pid} is not an appkit db command, for example because a reboot reused it, the lock is stale. ${recovery}`,
  );
}

/**
 * Run fn as the only writer of the checkout's migration history. The lock is
 * config/database/.appkit-db.lock, created exclusively; a second command in
 * the same checkout, in this process or another, fails with who holds it.
 * Released when fn settles or the process exits. A process killed by a signal
 * leaves the file behind: the next command reports it as stale, and it is
 * deleted by hand, never taken over.
 */
export async function withHistoryLock<T>(
  root: string,
  command: string,
  fn: (lock: HistoryLock) => Promise<T>,
): Promise<T> {
  const folder = migrationsFolder(root);
  const file = path.join(path.dirname(folder), LOCK_FILE);
  const owner: LockOwner = {
    pid: process.pid,
    host: os.hostname(),
    command,
    startedAt: new Date().toISOString(),
    token: randomUUID(),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let fd: number;
  try {
    fd = fs.openSync(file, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw heldError(root, file);
  }
  try {
    fs.writeFileSync(fd, JSON.stringify(owner));
  } catch (error) {
    fs.rmSync(file, { force: true });
    throw error;
  } finally {
    fs.closeSync(fd);
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.removeListener("exit", release);
    if (readOwner(file)?.token === owner.token)
      fs.rmSync(file, { force: true });
  };
  process.on("exit", release);
  const lock = {
    folder,
    assertHeld() {
      if (released) {
        throw new Error(
          `The migration history lock of ${root} was released; take it again before writing.`,
        );
      }
    },
  } as HistoryLock;
  try {
    return await fn(lock);
  } finally {
    release();
  }
}
