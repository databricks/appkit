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
const { execFileSync } = vi.hoisted(() => ({
  execFileSync: vi.fn(),
}));

// ensureAstGrepBinding runs the pre-fetch in a time-bounded child process via
// execFileSync. Mock it so the test never spawns a real process or touches the
// network/filesystem.
vi.mock("node:child_process", () => ({ execFileSync }));

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

  test("pre-fetches @ast-grep/napi in a time-bounded child under an npm user agent", () => {
    process.env.npm_config_user_agent = "npm/10.0.0 node/v22.0.0 darwin arm64";

    ensureAstGrepBinding();

    expect(execFileSync).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = execFileSync.mock.calls[0] as [
      string,
      string[],
      { timeout?: number },
    ];
    expect(bin).toBe(process.execPath);
    expect(args.join(" ")).toContain("@ast-grep/napi");
    // The pre-fetch MUST be bounded so a hung/slow fetch cannot block `npm install`.
    expect(opts.timeout).toBeGreaterThan(0);
  });

  test("is non-fatal when the pre-fetch fails or times out", () => {
    process.env.npm_config_user_agent = "npm/10.0.0 node/v22.0.0 darwin arm64";
    // execFileSync throws on both a non-zero child exit and a timeout kill.
    execFileSync.mockImplementation(() => {
      throw new Error("ETIMEDOUT");
    });

    // Must not throw — a failed/timed-out pre-fetch must never break `npm install`.
    expect(() => ensureAstGrepBinding()).not.toThrow();
    // And it warns exactly once on stderr (via console.error).
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0]?.[0]).toContain("@ast-grep/napi");
  });

  test("does nothing under a non-npm user agent (e.g. pnpm)", () => {
    process.env.npm_config_user_agent =
      "pnpm/10.21.0 npm/? node/v22.0.0 darwin arm64";

    ensureAstGrepBinding();

    expect(execFileSync).not.toHaveBeenCalled();
  });
});
