import { createHash } from "node:crypto";

// Branch names AppKit creates. Branch IDs: 1-63 chars, start with a
// lowercase letter, lowercase letters, digits and hyphens only.

const MAX_BRANCH_ID = 63;
const DEV_PREFIX = "dev-";
const SESSION_PREFIX = "session-";
const HASH_LENGTH = 6;

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
