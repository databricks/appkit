import fs from "node:fs";
import path from "node:path";

import dotenv from "dotenv";
import { afterEach, describe, expect, test } from "vitest";

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

  test("a missing .env starts from .env.example", () => {
    const root = tempApp({
      ".env.example": "PGHOST=your_postgres_host\nPGPORT=5432\n",
    });
    const file = path.join(root, ".env");

    updateEnvFile(
      file,
      { PGHOST: "h.example.com" },
      path.join(root, ".env.example"),
    );

    expect(fs.readFileSync(file, "utf-8")).toBe(
      "PGHOST=h.example.com\nPGPORT=5432\n",
    );
    expect(fs.readFileSync(path.join(root, ".env.example"), "utf-8")).toContain(
      "your_postgres_host",
    );
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
