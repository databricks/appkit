import { createHash, randomInt } from "node:crypto";

// Branch names AppKit creates. Branch IDs: 1-63 chars, start with a
// lowercase letter, lowercase letters, digits and hyphens only.

const MAX_BRANCH_ID = 63;
const DEV_PREFIX = "dev-";
const SESSION_PREFIX = "session-";
const HASH_LENGTH = 6;

/** Seven days: a session branch outlives a working week, then expires on its own. */
export const SESSION_BRANCH_TTL = "604800s";

const SESSION_ID = /^[a-z0-9]{1,55}$/;

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * dev-<slug(local part)>-<sha256(userName)[0:6]>. The hash keeps users who share
 * a local part apart; the name is the same on every machine.
 */
export function devBranchId(userName: string): string {
  const normalized = userName.trim().toLowerCase();
  const hash = createHash("sha256")
    .update(normalized)
    .digest("hex")
    .slice(0, HASH_LENGTH);
  const room = MAX_BRANCH_ID - DEV_PREFIX.length - 1 - HASH_LENGTH;
  const local = slug(normalized.split("@")[0] ?? "")
    .slice(0, room)
    .replace(/-+$/, "");
  return `${DEV_PREFIX}${local || "user"}-${hash}`;
}

export function isValidSessionId(sessionId: string): boolean {
  return SESSION_ID.test(sessionId);
}

export function sessionBranchId(sessionId: string): string {
  if (!isValidSessionId(sessionId)) {
    throw new Error(
      `Invalid APPKIT_DB_SESSION ${JSON.stringify(sessionId)}: use 1-55 lowercase letters or digits.`,
    );
  }
  return `${SESSION_PREFIX}${sessionId}`;
}

const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";

/** 8 random base36 characters, generated once per checkout and kept in .env. */
export function newSessionId(): string {
  let id = "";
  for (let i = 0; i < 8; i++) id += BASE36[randomInt(BASE36.length)];
  return id;
}
