import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { refuseSymlink, SymlinkRefusedError, writeFileAtomic } from "../files";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "appkit-files-"));
  dirs.push(dir);
  return dir;
};

describe("writeFileAtomic", () => {
  test("creates the file, replaces it, and leaves no temporary file behind", () => {
    const dir = tempDir();
    const file = path.join(dir, "a.txt");

    writeFileAtomic(file, "one");
    expect(fs.readFileSync(file, "utf-8")).toBe("one");

    writeFileAtomic(file, "two");
    expect(fs.readFileSync(file, "utf-8")).toBe("two");
    expect(fs.readdirSync(dir)).toEqual(["a.txt"]);
  });

  test("refuses a symbolic link and leaves the link and its target as they were", () => {
    const dir = tempDir();
    const target = path.join(dir, "target.txt");
    fs.writeFileSync(target, "kept");
    const link = path.join(dir, "link.txt");
    fs.symlinkSync(target, link);

    expect(() => writeFileAtomic(link, "new")).toThrow(SymlinkRefusedError);

    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, "utf-8")).toBe("kept");
    expect(fs.readdirSync(dir).sort()).toEqual(["link.txt", "target.txt"]);
  });

  test("a write that fails leaves no temporary file behind", () => {
    const dir = tempDir();

    expect(() =>
      writeFileAtomic(path.join(dir, "missing", "a.txt"), "x"),
    ).toThrow();

    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe("refuseSymlink", () => {
  test("passes a missing file and a regular file", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "plain"), "");

    expect(() => refuseSymlink(path.join(dir, "none"))).not.toThrow();
    expect(() => refuseSymlink(path.join(dir, "plain"))).not.toThrow();
  });

  test("refuses a dangling link too, naming it", () => {
    const dir = tempDir();
    const link = path.join(dir, "link");
    fs.symlinkSync(path.join(dir, "none"), link);

    expect(() => refuseSymlink(link)).toThrow(new SymlinkRefusedError(link));
  });
});
