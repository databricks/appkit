import { describe, expect, test } from "vitest";
import {
  type FileAction,
  type FilePolicyUser,
  type FileResource,
  PolicyDeniedError,
  policy,
  READ_ACTIONS,
  WRITE_ACTIONS,
} from "../policy";

const user: FilePolicyUser = { id: "user-1" };
const resource: FileResource = { path: "/file.txt", volume: "uploads" };

describe("FileAction sets", () => {
  test("READ_ACTIONS contains all read actions", () => {
    for (const a of [
      "list",
      "read",
      "download",
      "raw",
      "exists",
      "metadata",
      "preview",
    ] as FileAction[]) {
      expect(READ_ACTIONS.has(a)).toBe(true);
    }
  });

  test("WRITE_ACTIONS contains all write actions", () => {
    for (const a of ["upload", "mkdir", "delete"] as FileAction[]) {
      expect(WRITE_ACTIONS.has(a)).toBe(true);
    }
  });

  test("READ_ACTIONS and WRITE_ACTIONS are disjoint", () => {
    for (const a of READ_ACTIONS) {
      expect(WRITE_ACTIONS.has(a)).toBe(false);
    }
  });
});

describe("policy.publicRead()", () => {
  const p = policy.publicRead();

  test("allows read actions", () => {
    for (const a of READ_ACTIONS) {
      expect(p(a, resource, user)).toBe(true);
    }
  });

  test("denies write actions", () => {
    for (const a of WRITE_ACTIONS) {
      expect(p(a, resource, user)).toBe(false);
    }
  });
});

describe("policy.denyAll() / policy.allowAll()", () => {
  test("denyAll denies everything", () => {
    const p = policy.denyAll();
    expect(p("list", resource, user)).toBe(false);
    expect(p("upload", resource, user)).toBe(false);
  });

  test("allowAll allows everything", () => {
    const p = policy.allowAll();
    expect(p("list", resource, user)).toBe(true);
    expect(p("upload", resource, user)).toBe(true);
  });
});

describe("policy.all()", () => {
  test("returns true when all policies allow", async () => {
    const p = policy.all(policy.allowAll(), policy.allowAll());
    expect(await p("list", resource, user)).toBe(true);
  });

  test("short-circuits on first deny", async () => {
    let secondCalled = false;
    const p = policy.all(policy.denyAll(), () => {
      secondCalled = true;
      return true;
    });
    expect(await p("list", resource, user)).toBe(false);
    expect(secondCalled).toBe(false);
  });

  test("throws when called with no policies", () => {
    expect(() => policy.all()).toThrow(
      "policy.all() requires at least one policy",
    );
  });
});

describe("policy.any()", () => {
  test("returns false when all policies deny", async () => {
    const p = policy.any(policy.denyAll(), policy.denyAll());
    expect(await p("list", resource, user)).toBe(false);
  });

  test("short-circuits on first allow", async () => {
    let secondCalled = false;
    const p = policy.any(policy.allowAll(), () => {
      secondCalled = true;
      return false;
    });
    expect(await p("list", resource, user)).toBe(true);
    expect(secondCalled).toBe(false);
  });

  test("throws when called with no policies", () => {
    expect(() => policy.any()).toThrow(
      "policy.any() requires at least one policy",
    );
  });
});

describe("policy.not()", () => {
  test("inverts allow to deny", async () => {
    const p = policy.not(policy.allowAll());
    expect(await p("list", resource, user)).toBe(false);
  });

  test("inverts deny to allow", async () => {
    const p = policy.not(policy.denyAll());
    expect(await p("list", resource, user)).toBe(true);
  });
});

describe("async policy support", () => {
  test("handles async policy that returns Promise<boolean>", async () => {
    const asyncPolicy = async () => true;
    const p = policy.all(asyncPolicy);
    expect(await p("list", resource, user)).toBe(true);
  });
});

describe("PolicyDeniedError", () => {
  test("has correct name and message", () => {
    const err = new PolicyDeniedError("upload", "images");
    expect(err.name).toBe("PolicyDeniedError");
    expect(err.message).toBe('Policy denied "upload" on volume "images"');
    expect(err.action).toBe("upload");
    expect(err.volumeKey).toBe("images");
    expect(err instanceof Error).toBe(true);
  });
});
