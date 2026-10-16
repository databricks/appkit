import { describe, expect, test } from "vitest";

import {
  devBranchId,
  isValidSessionId,
  newSessionId,
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

  test("session branches are session-<id>; ids are lowercase base36", () => {
    const sessionId = newSessionId();
    expect(sessionId).toMatch(/^[0-9a-z]{8}$/);
    expect(sessionBranchId(sessionId)).toBe(`session-${sessionId}`);
    expect(isValidSessionId("Bad-Id")).toBe(false);
    expect(() => sessionBranchId("Bad-Id")).toThrow(/APPKIT_DB_SESSION/);
    expect(SESSION_BRANCH_TTL).toBe("604800s");
  });
});
