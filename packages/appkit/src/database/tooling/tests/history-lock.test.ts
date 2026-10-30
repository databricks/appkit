import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { withHistoryLock } from "../history-lock";
import { cleanupTempApps, tempApp } from "./fakes";

afterEach(cleanupTempApps);

const LOCK = "config/database/.appkit-db.lock";

function writeLock(root: string, contents: string): void {
  fs.mkdirSync(path.dirname(path.join(root, LOCK)), { recursive: true });
  fs.writeFileSync(path.join(root, LOCK), contents);
}

async function failure(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error("expected the lock to be refused");
    },
    (error: Error) => error,
  );
}

describe("withHistoryLock", () => {
  test("a second command in the checkout fails with who holds it, and the lock goes when the first finishes", async () => {
    const root = tempApp();

    const result = await withHistoryLock(root, "migrate", async () => {
      const file = path.join(root, LOCK);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      const owner = JSON.parse(fs.readFileSync(file, "utf-8"));
      expect(owner).toMatchObject({
        pid: process.pid,
        host: os.hostname(),
        command: "migrate",
      });

      const error = await failure(
        withHistoryLock(root, "introspect", async () => "ran"),
      );
      expect(error.message).toBe(
        `Another \`appkit db migrate\` (pid ${process.pid} on ${os.hostname()}, since ${owner.startedAt}) is changing the migration history in config/database. Wait for it to finish, then rerun. If pid ${process.pid} is not an appkit db command, for example because a reboot reused it, the lock is stale. Make sure no appkit db command runs in this checkout, delete ${LOCK}, then rerun.`,
      );
      return "done";
    });

    expect(result).toBe("done");
    expect(fs.existsSync(path.join(root, LOCK))).toBe(false);
    await expect(
      withHistoryLock(root, "introspect", async () => "ran"),
    ).resolves.toBe("ran");
  });

  test("the lock goes when the command throws too", async () => {
    const root = tempApp();
    const thrown = new Error("generation failed");

    await expect(
      withHistoryLock(root, "migrate", async () => {
        throw thrown;
      }),
    ).rejects.toBe(thrown);
    expect(fs.existsSync(path.join(root, LOCK))).toBe(false);
  });

  test("a lock left by a process that exited is reported stale and kept byte for byte", async () => {
    const root = tempApp();
    const child = spawn(process.execPath, ["-e", ""]);
    await new Promise((resolve) => child.once("exit", resolve));
    const stale = JSON.stringify({
      pid: child.pid,
      host: os.hostname(),
      command: "migrate",
      startedAt: "2026-01-01T00:00:00.000Z",
      token: "theirs",
    });
    writeLock(root, stale);

    const error = await failure(
      withHistoryLock(root, "migrate", async () => "ran"),
    );

    expect(error.message).toBe(
      `\`appkit db migrate\` (pid ${child.pid}) stopped without releasing ${LOCK}. Make sure no appkit db command runs in this checkout, delete ${LOCK}, then rerun.`,
    );
    expect(fs.readFileSync(path.join(root, LOCK), "utf-8")).toBe(stale);
  });

  test("a lock from another host, or one that cannot be read, is never taken over", async () => {
    const root = tempApp();
    const elsewhere = JSON.stringify({
      pid: process.pid,
      host: "build-agent-7",
      command: "clean",
      startedAt: "2026-01-01T00:00:00.000Z",
      token: "theirs",
    });

    for (const [contents, holder] of [
      [elsewhere, " on build-agent-7"],
      ["", ""],
    ] as const) {
      writeLock(root, contents);
      const error = await failure(
        withHistoryLock(root, "migrate", async () => "ran"),
      );
      expect(error.message).toBe(
        `${LOCK} says another appkit db command${holder} is changing the migration history. Make sure no appkit db command runs in this checkout, delete ${LOCK}, then rerun.`,
      );
      expect(fs.readFileSync(path.join(root, LOCK), "utf-8")).toBe(contents);
    }
  });

  test("releasing leaves a lock another holder wrote in its place", async () => {
    const root = tempApp();
    const replaced = JSON.stringify({
      pid: process.pid,
      host: os.hostname(),
      command: "migrate",
      startedAt: "2026-01-01T00:00:00.000Z",
      token: "theirs",
    });

    await withHistoryLock(root, "migrate", async () => {
      fs.writeFileSync(path.join(root, LOCK), replaced);
    });

    expect(fs.readFileSync(path.join(root, LOCK), "utf-8")).toBe(replaced);
  });
});
