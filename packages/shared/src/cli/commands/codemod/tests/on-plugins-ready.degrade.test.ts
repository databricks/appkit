import fs from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";

// Force loadAstGrepOrThrow to behave as it would when the native binary is
// unavailable, while keeping the real AstGrepUnavailableError class so the
// command's `instanceof` discrimination still holds.
vi.mock("../../../ast-grep", async () => {
  const actual =
    await vi.importActual<typeof import("../../../ast-grep")>(
      "../../../ast-grep",
    );
  return {
    ...actual,
    loadAstGrepOrThrow: vi.fn(() => {
      throw new actual.AstGrepUnavailableError("ast-grep unavailable (test)");
    }),
  };
});

import { AstGrepUnavailableError } from "../../../ast-grep";
import { migrateFile } from "../on-plugins-ready";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("codemod on-plugins-ready — ast-grep unavailable (require)", () => {
  test("migrateFile throws AstGrepUnavailableError, not a raw MODULE_NOT_FOUND", () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue("const x = 1;");
    expect(() => migrateFile("/fake/server.ts")).toThrow(
      AstGrepUnavailableError,
    );
  });
});
