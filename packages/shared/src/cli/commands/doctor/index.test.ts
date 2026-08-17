import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadEnvFile } from "./index";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "doctor-envfile-"));
}

describe("loadEnvFile", () => {
  const dirs: string[] = [];
  const savedKeys = ["DOCTOR_ENVFILE_B"];

  afterEach(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
    for (const k of savedKeys) delete process.env[k];
  });

  function writeEnv(contents: string): string {
    const dir = makeTempDir();
    dirs.push(dir);
    const p = path.join(dir, ".env.local");
    fs.writeFileSync(p, contents);
    return p;
  }

  it("overrides an already-set value (so it beats the auto-loaded .env)", () => {
    process.env.DOCTOR_ENVFILE_B = "from-default-env";
    loadEnvFile(writeEnv("DOCTOR_ENVFILE_B=from-explicit-file\n"));
    expect(process.env.DOCTOR_ENVFILE_B).toBe("from-explicit-file");
  });

  it("throws a clear error when the file does not exist", () => {
    expect(() => loadEnvFile("/no/such/.env.local")).toThrow(
      /env file not found/,
    );
  });
});
