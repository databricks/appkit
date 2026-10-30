import { createHash, randomInt } from "node:crypto";

// Branch names AppKit creates. Branch IDs: 1-63 chars, start with a
// lowercase letter, lowercase letters, digits and hyphens only.

const MAX_BRANCH_ID = 63;
const DEV_PREFIX = "dev-";
const SESSION_PREFIX = "session-";
const HASH_LENGTH = 6;

/** Seven days: a session branch outlives a working week, then expires on its own. */
export const SESSION_BRANCH_TTL = "604800s";
const SESSION_ID_LENGTH =
  MAX_BRANCH_ID - SESSION_PREFIX.length - HASH_LENGTH - 1;
const SESSION_ID = new RegExp(`^[a-z0-9]{1,${SESSION_ID_LENGTH}}$`);

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalized(userName: string): string {
  return userName.trim().toLowerCase();
}

/** sha256(userName)[0:6]: the part of a branch name that says whose it is. */
function userHash(userName: string): string {
  return createHash("sha256")
    .update(normalized(userName))
    .digest("hex")
    .slice(0, HASH_LENGTH);
}

/**
 * dev-<slug(local part)>-<userHash>. The hash keeps users who share a local
 * part apart; the name is the same on every machine.
 */
export function devBranchId(userName: string): string {
  const room = MAX_BRANCH_ID - DEV_PREFIX.length - 1 - HASH_LENGTH;
  const local = slug(normalized(userName).split("@")[0] ?? "")
    .slice(0, room)
    .replace(/-+$/, "");
  return `${DEV_PREFIX}${local || "user"}-${userHash(userName)}`;
}

export function isValidSessionId(sessionId: string): boolean {
  return SESSION_ID.test(sessionId);
}

/**
 * session-<userHash>-<sessionId>. The id lives in this checkout's .env; the
 * hash makes a copied .env name a branch only its creator passes the guard on.
 */
export function sessionBranchId(userName: string, sessionId: string): string {
  if (!isValidSessionId(sessionId)) {
    throw new Error(
      `Invalid APPKIT_DB_SESSION ${JSON.stringify(sessionId)}: use 1-${SESSION_ID_LENGTH} lowercase letters or digits.`,
    );
  }
  return `${SESSION_PREFIX}${userHash(userName)}-${sessionId}`;
}

/** Whether a branch id is one of this user's dev or session branches. */
export function isUsersBranchId(userName: string, branchId: string): boolean {
  return (
    branchId === devBranchId(userName) ||
    branchId.startsWith(`${SESSION_PREFIX}${userHash(userName)}-`)
  );
}

const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";

/** 8 random base36 characters, generated once per checkout and kept in .env. */
export function newSessionId(): string {
  let id = "";
  for (let i = 0; i < 8; i++) id += BASE36[randomInt(BASE36.length)];
  return id;
}

const TTL = /^(\d+)([smhd])$/;
const SECONDS = { s: 1, m: 60, h: 3_600, d: 86_400 } as const;

/** `--ttl 30m`, `1h`, `7d` or `3600s` as the API's duration ("3600s"). */
export function parseTtl(value: string): string {
  const match = TTL.exec(value.trim());
  const amount = Number(match?.[1]);
  if (!match || amount <= 0) {
    throw new Error(
      `Invalid --ttl ${JSON.stringify(value)}: use a positive number of seconds, minutes, hours or days, e.g. 30m, 1h or 7d.`,
    );
  }
  return `${amount * SECONDS[match[2] as keyof typeof SECONDS]}s`;
}
