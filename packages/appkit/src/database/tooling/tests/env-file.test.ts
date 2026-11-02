import fs from "node:fs";
import path from "node:path";

import dotenv from "dotenv";
import { afterEach, describe, expect, test, vi } from "vitest";

import { updateEnvFile } from "../env-file";
import { cleanupTempApps, tempApp } from "./fakes";

afterEach(cleanupTempApps);

describe("updateEnvFile", () => {
  test("replaces values in place, keeps comments and order, appends new keys", () => {
    const root = tempApp({
      ".env": [
        "# Databricks",
        "DATABRICKS_CONFIG_PROFILE=DEFAULT",
        "PGHOST='old-host'",
        "",
        "# keep me",
        "LAKEBASE_ENDPOINT=projects/p/branches/old/endpoints/primary",
        "APPKIT_DB_SESSION=abc",
        "PGHOST=duplicate",
      ].join("\n"),
    });
    const file = path.join(root, ".env");

    updateEnvFile(file, {
      PGHOST: "new-host.example.com",
      LAKEBASE_ENDPOINT: "projects/p/branches/dev-a/endpoints/primary",
      OTHER_KEY: "value",
    });

    expect(fs.readFileSync(file, "utf-8")).toBe(
      [
        "# Databricks",
        "DATABRICKS_CONFIG_PROFILE=DEFAULT",
        "PGHOST=new-host.example.com",
        "",
        "# keep me",
        "LAKEBASE_ENDPOINT=projects/p/branches/dev-a/endpoints/primary",
        "APPKIT_DB_SESSION=abc",
        "OTHER_KEY=value",
        "",
      ].join("\n"),
    );
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  test("a missing .env gets only the given keys, never .env.example's placeholders", () => {
    const root = tempApp({
      ".env.example": "DATABRICKS_HOST=https://your-workspace\nPGPORT=5432\n",
    });
    const file = path.join(root, ".env");

    updateEnvFile(file, { PGHOST: "h.example.com" });

    expect(fs.readFileSync(file, "utf-8")).toBe("PGHOST=h.example.com\n");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  test("a symbolic link is refused and its target left alone", () => {
    const root = tempApp({ "shared.env": "PGHOST=old\n" });
    const file = path.join(root, ".env");
    fs.symlinkSync(path.join(root, "shared.env"), file);

    expect(() => updateEnvFile(file, { PGHOST: "new" })).toThrow(
      `Refusing to rewrite ${file}: it is a symbolic link to ${path.join(root, "shared.env")}, and writing through it would change that file. Replace it with a regular file, then rerun.`,
    );
    expect(fs.readFileSync(path.join(root, "shared.env"), "utf-8")).toBe(
      "PGHOST=old\n",
    );
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
  });

  test("a multi-line quoted value is one entry: replaced whole, or kept whole", () => {
    const root = tempApp({
      ".env": [
        'PGHOST="first',
        "PGHOST=not-a-key",
        'still the value"',
        'CERT="-----BEGIN-----',
        "PGPORT=1",
        '-----END-----"',
        "PGPORT=5432",
      ].join("\n"),
    });
    const file = path.join(root, ".env");

    updateEnvFile(file, { PGHOST: "new.example.com", PGPORT: "6543" });

    const text = fs.readFileSync(file, "utf-8");
    expect(text).toBe(
      [
        "PGHOST=new.example.com",
        'CERT="-----BEGIN-----',
        "PGPORT=1",
        '-----END-----"',
        "PGPORT=6543",
        "",
      ].join("\n"),
    );
    expect(dotenv.parse(text)).toEqual({
      PGHOST: "new.example.com",
      CERT: "-----BEGIN-----\nPGPORT=1\n-----END-----",
      PGPORT: "6543",
    });
  });

  test("a value whose quote never closes is a single line, as dotenv reads it", () => {
    const root = tempApp({ ".env": 'NOTE="open\nPGHOST=old\n' });
    const file = path.join(root, ".env");

    updateEnvFile(file, { PGHOST: "new" });

    expect(fs.readFileSync(file, "utf-8")).toBe('NOTE="open\nPGHOST=new\n');
  });

  test("a failed write leaves the old file and no temporary file", () => {
    const root = tempApp({ ".env": "PGHOST=old\n" });
    const file = path.join(root, ".env");
    const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("disk full");
    });
    try {
      expect(() => updateEnvFile(file, { PGHOST: "new" })).toThrow("disk full");
    } finally {
      rename.mockRestore();
    }

    expect(fs.readFileSync(file, "utf-8")).toBe("PGHOST=old\n");
    expect(fs.readdirSync(root)).toEqual([".env"]);
  });

  test("quotes values that need it", () => {
    const root = tempApp();
    const file = path.join(root, ".env");
    updateEnvFile(file, { A: "has space", B: "plain@example.com" });
    expect(fs.readFileSync(file, "utf-8")).toBe(
      'A="has space"\nB=plain@example.com\n',
    );
  });

  test("keeps export prefixes and CRLF line endings", () => {
    const root = tempApp({
      ".env": "# keep\r\nexport PGHOST=old\r\nPGPORT=5432\r\n",
    });
    const file = path.join(root, ".env");

    updateEnvFile(file, { PGHOST: "new.example.com", PGUSER: "a@example.com" });

    expect(fs.readFileSync(file, "utf-8")).toBe(
      "# keep\r\nexport PGHOST=new.example.com\r\nPGPORT=5432\r\nPGUSER=a@example.com\r\n",
    );
  });

  test("every value stays on one line and reads back unchanged", () => {
    const root = tempApp({ ".env": "KEEP=1\n" });
    const file = path.join(root, ".env");
    const values = {
      NEWLINE: "line1\nline2\r\nINJECTED=1",
      QUOTES: 'say "hi"',
      BACKSLASH: "back\\slash",
    };

    updateEnvFile(file, values);

    const text = fs.readFileSync(file, "utf-8");
    expect(text.split("\n").filter(Boolean)).toHaveLength(4);
    expect(dotenv.parse(text)).toEqual({ KEEP: "1", ...values });
  });

  test("a value dotenv cannot read back unchanged is refused", () => {
    const root = tempApp();
    const file = path.join(root, ".env");
    expect(() => updateEnvFile(file, { BAD: `it's "x"\ny` })).toThrow(
      "Cannot write BAD to .env: its value mixes quotes, backslashes and line breaks.",
    );
    expect(fs.existsSync(file)).toBe(false);
  });
});
