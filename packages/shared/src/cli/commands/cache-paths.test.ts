import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { getCommittedCacheDir, getEphemeralStateDir } from "./cache-paths";

describe("cache-paths", () => {
  test("getCommittedCacheDir returns the .appkit directory under root", () => {
    const root = path.join(os.tmpdir(), "some-project");
    expect(getCommittedCacheDir(root)).toBe(path.join(root, ".appkit"));
  });

  test("getCommittedCacheDir defaults to process.cwd() when no argument is given", () => {
    expect(getCommittedCacheDir()).toBe(path.join(process.cwd(), ".appkit"));
  });

  test("getEphemeralStateDir returns node_modules/.databricks/appkit under root", () => {
    const root = path.join(os.tmpdir(), "some-project");
    expect(getEphemeralStateDir(root)).toBe(
      path.join(root, "node_modules", ".databricks", "appkit"),
    );
  });

  test("getEphemeralStateDir defaults to process.cwd() when no argument is given", () => {
    expect(getEphemeralStateDir()).toBe(
      path.join(process.cwd(), "node_modules", ".databricks", "appkit"),
    );
  });
});
