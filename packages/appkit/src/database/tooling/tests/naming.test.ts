import { describe, expect, test } from "vitest";

import {
  devBranchId,
  isUsersBranchId,
  isValidSessionId,
  newSessionId,
  parseTtl,
  SESSION_BRANCH_TTL,
  sessionBranchId,
} from "../naming";

const BRANCH_ID = /^[a-z][a-z0-9-]{0,62}$/;

describe("branch naming", () => {
  test("dev branches are dev-<slug(local part)>-<6 hex>, stable and case-insensitive", () => {
    const id = devBranchId("Alice.Smith@example.com");
    expect(id).toMatch(/^dev-alice-smith-[0-9a-f]{6}$/);
    expect(devBranchId("alice.smith@example.com")).toBe(id);
    expect(id).toMatch(BRANCH_ID);
  });

  test("users sharing a local part get different branches", () => {
    expect(devBranchId("alice@example.com")).not.toBe(
      devBranchId("alice@example.org"),
    );
  });

  test("long or odd local parts stay within the 63-character limit", () => {
    const id = devBranchId(`${"x".repeat(80)}@example.com`);
    expect(id.length).toBeLessThanOrEqual(63);
    expect(id).toMatch(BRANCH_ID);
    expect(devBranchId("__@example.com")).toMatch(/^dev-user-[0-9a-f]{6}$/);
  });

  test("a service principal's client ID makes a valid branch ID too", () => {
    expect(devBranchId("11111111-2222-3333-4444-555555555555")).toMatch(
      BRANCH_ID,
    );
  });

  test("session branches are session-<user hash>-<id>; ids are lowercase base36", () => {
    const sessionId = newSessionId();
    expect(sessionId).toMatch(/^[0-9a-z]{8}$/);
    const hash = devBranchId("alice@example.com").slice(-6);
    expect(sessionBranchId("Alice@example.com", sessionId)).toBe(
      `session-${hash}-${sessionId}`,
    );
    expect(isValidSessionId("Bad-Id")).toBe(false);
    expect(() => sessionBranchId("alice@example.com", "Bad-Id")).toThrow(
      /APPKIT_DB_SESSION/,
    );
    expect(SESSION_BRANCH_TTL).toBe("604800s");
  });

  test("the longest session id still makes a valid branch ID", () => {
    const id = sessionBranchId("alice@example.com", "a".repeat(48));
    expect(id).toHaveLength(63);
    expect(id).toMatch(BRANCH_ID);
    expect(isValidSessionId("a".repeat(49))).toBe(false);
  });

  test("a copied .env names a session branch only its creator owns", () => {
    const alice = "alice@example.com";
    const bob = "bob@example.com";
    expect(sessionBranchId(alice, "abc")).not.toBe(sessionBranchId(bob, "abc"));
    expect(isUsersBranchId(alice, sessionBranchId(alice, "abc"))).toBe(true);
    expect(isUsersBranchId(alice, devBranchId(alice))).toBe(true);
    expect(isUsersBranchId(alice, sessionBranchId(bob, "abc"))).toBe(false);
    expect(isUsersBranchId(alice, devBranchId(bob))).toBe(false);
    expect(isUsersBranchId(alice, "production")).toBe(false);
  });
});

describe("parseTtl", () => {
  test.each([
    ["90s", "90s"],
    ["30m", "1800s"],
    [" 1h ", "3600s"],
    ["7d", "604800s"],
  ])("%s is %s", (value, expected) => {
    expect(parseTtl(value)).toBe(expected);
  });

  test.each(["0h", "1w", "1.5h", "-1h", "h", ""])("refuses %j", (value) => {
    expect(() => parseTtl(value)).toThrow(
      `Invalid --ttl ${JSON.stringify(value)}: use a positive number of seconds, minutes, hours or days, e.g. 30m, 1h or 7d.`,
    );
  });
});
