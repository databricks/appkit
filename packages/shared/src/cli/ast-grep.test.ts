import { describe, expect, test, vi } from "vitest";

// Simulate a platform where @ast-grep/napi's native binary was never
// materialized (e.g. an Apps remote-install that omitted optional deps):
// createRequire hands back a require() that throws MODULE_NOT_FOUND for the
// package, exactly like the real failure on deploy.
vi.mock("node:module", async () => {
  const actual =
    await vi.importActual<typeof import("node:module")>("node:module");
  return {
    ...actual,
    createRequire: (...args: Parameters<typeof actual.createRequire>) => {
      const realRequire = actual.createRequire(...args);
      const fakeRequire = ((id: string) => {
        if (id === "@ast-grep/napi") {
          const err = new Error(
            "Cannot find module '@ast-grep/napi-linux-x64-gnu'",
          ) as NodeJS.ErrnoException;
          err.code = "MODULE_NOT_FOUND";
          throw err;
        }
        return realRequire(id);
      }) as NodeJS.Require;
      return fakeRequire;
    },
  };
});

const { AstGrepUnavailableError, loadAstGrepOrThrow, tryLoadAstGrep } =
  await import("./ast-grep");

describe("@ast-grep/napi lazy loader — native binary unavailable", () => {
  test("tryLoadAstGrep() returns null instead of throwing", () => {
    expect(tryLoadAstGrep()).toBeNull();
  });

  test("loadAstGrepOrThrow() throws an AstGrepUnavailableError", () => {
    expect(() => loadAstGrepOrThrow()).toThrow(AstGrepUnavailableError);
  });

  test("the thrown message is actionable, not a raw MODULE_NOT_FOUND stack", () => {
    let message = "";
    try {
      loadAstGrepOrThrow();
    } catch (error) {
      message = (error as Error).message;
    }
    // Names the package and the concrete remedy...
    expect(message).toContain("@ast-grep/napi");
    expect(message).toContain("--include=optional");
    // ...and never surfaces the opaque native-binary failure to the user.
    expect(message).not.toContain("MODULE_NOT_FOUND");
  });
});
