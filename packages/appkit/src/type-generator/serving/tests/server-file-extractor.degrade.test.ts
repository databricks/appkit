import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Force the lazy ast-grep loader to report the native binary as unavailable.
vi.mock("../../../internal/ast-grep", () => ({
  tryLoadAstGrep: vi.fn(() => null),
}));

import { extractServingEndpoints } from "../server-file-extractor";

describe("extractServingEndpoints — ast-grep unavailable (degrade)", () => {
  beforeEach(() => {
    // Valid server file with inline endpoints; extraction would succeed if
    // ast-grep were available, so a null result proves the degrade path ran.
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      `import { createApp, serving } from "@databricks/appkit";
createApp({ plugins: [serving({ endpoints: { demo: { env: "X" } } })] });`,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("returns null instead of throwing", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(extractServingEndpoints("/app/server/index.ts")).toBeNull();
  });

  test("warns that serving-endpoint auto-discovery was skipped", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    extractServingEndpoints("/app/server/index.ts");
    const logged = warn.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(logged).toContain("native binary is unavailable");
    expect(logged).toContain("/app/server/index.ts");
  });
});
