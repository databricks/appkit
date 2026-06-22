import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type Mock,
  test,
  vi,
} from "vitest";

// The system under test lives in the standalone, self-contained postinstall script
// that ships verbatim in the published package (see tools/dist-appkit.ts). We import
// it here (not a copy) so the published behavior is what gets exercised. The script's
// top-level main guard means importing it does NOT trigger the install side effect.

// vi.mock factories are hoisted above the imports, so the spy must be created in a
// hoisted block too (a plain const would be in the TDZ when the factory runs).
const { checkAndPreparePackage } = vi.hoisted(() => ({
  checkAndPreparePackage: vi.fn(async () => {}),
}));

// napi-postinstall is loaded via dynamic `await import("napi-postinstall")` inside
// ensureAstGrepBinding. Mock it so the test never touches the network or filesystem.
vi.mock("napi-postinstall", () => ({ checkAndPreparePackage }));

import { ensureAstGrepBinding } from "../../scripts/postinstall.js";

describe("ensureAstGrepBinding (postinstall native-binding pre-fetch)", () => {
  const prevUserAgent = process.env.npm_config_user_agent;
  let consoleError: Mock;

  beforeEach(() => {
    vi.clearAllMocks();
    // Silence the non-fatal warning (console.error -> stderr) so failing-path
    // tests don't pollute output, and so we can assert it fired exactly once.
    consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {}) as Mock;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (prevUserAgent === undefined) {
      delete process.env.npm_config_user_agent;
    } else {
      process.env.npm_config_user_agent = prevUserAgent;
    }
  });

  test("pre-fetches @ast-grep/napi under an npm user agent", async () => {
    process.env.npm_config_user_agent = "npm/10.0.0 node/v22.0.0 darwin arm64";

    await ensureAstGrepBinding();

    expect(checkAndPreparePackage).toHaveBeenCalledTimes(1);
    expect(checkAndPreparePackage).toHaveBeenCalledWith("@ast-grep/napi");
  });

  test("is non-fatal when checkAndPreparePackage rejects", async () => {
    process.env.npm_config_user_agent = "npm/10.0.0 node/v22.0.0 darwin arm64";
    checkAndPreparePackage.mockRejectedValueOnce(new Error("network down"));

    // Must resolve (not reject) — a failed pre-fetch must never break `npm install`.
    await expect(ensureAstGrepBinding()).resolves.toBeUndefined();
    // And it warns exactly once on stderr (via console.error).
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0]?.[0]).toContain("@ast-grep/napi");
  });

  test("does nothing under a non-npm user agent (e.g. pnpm)", async () => {
    process.env.npm_config_user_agent =
      "pnpm/10.21.0 npm/? node/v22.0.0 darwin arm64";

    await ensureAstGrepBinding();

    expect(checkAndPreparePackage).not.toHaveBeenCalled();
  });
});
