import { createHash, randomInt } from "node:crypto";

import {
  DEV_PREFIX,
  USER_HASH_HEX_LENGTH,
  LAKEBASE_MAX_BRANCH_ID_LENGTH,
  SESSION_ID_LENGTH,
  SESSION_PREFIX,
} from "../branch-names";

// Branch IDs: 1-63 chars, start with a lowercase letter, lowercase letters,
// digits and hyphens only.

export const SESSION_BRANCH_TTL = "604800s";
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

function userHash(userName: string): string {
  return createHash("sha256")
    .update(normalized(userName))
    .digest("hex")
    .slice(0, USER_HASH_HEX_LENGTH);
}

export function devBranchId(userName: string): string {
  const room =
    LAKEBASE_MAX_BRANCH_ID_LENGTH -
    DEV_PREFIX.length -
    1 -
    USER_HASH_HEX_LENGTH;
  const local = slug(normalized(userName).split("@")[0] ?? "")
    .slice(0, room)
    .replace(/-+$/, "");
  return `${DEV_PREFIX}${local || "user"}-${userHash(userName)}`;
}

export function isValidSessionId(sessionId: string): boolean {
  return SESSION_ID.test(sessionId);
}

export function parseSessionId(sessionId: string): string {
  if (!isValidSessionId(sessionId)) {
    throw new Error(
      `Invalid APPKIT_DB_SESSION ${JSON.stringify(sessionId)}: use 1-${SESSION_ID_LENGTH} lowercase letters or digits.`,
    );
  }
  return sessionId;
}

export function sessionBranchId(userName: string, sessionId: string): string {
  return `${SESSION_PREFIX}${userHash(userName)}-${parseSessionId(sessionId)}`;
}

export function isUsersSessionBranchId(
  userName: string,
  branchId: string,
): boolean {
  return branchId.startsWith(`${SESSION_PREFIX}${userHash(userName)}-`);
}

export function isUsersBranchId(userName: string, branchId: string): boolean {
  return (
    branchId === devBranchId(userName) ||
    isUsersSessionBranchId(userName, branchId)
  );
}

const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";

export function newSessionId(): string {
  let id = "";
  for (let i = 0; i < 8; i++) id += BASE36[randomInt(BASE36.length)];
  return id;
}

const TTL = /^(\d+)([smhd])$/;
const SECONDS = { s: 1, m: 60, h: 3_600, d: 86_400 } as const;

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
