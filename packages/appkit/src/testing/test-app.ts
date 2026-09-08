import type { PluginConstructor, PluginData } from "shared";
import { afterEach, beforeEach } from "vitest";

import type { CreateTestAppOptions, TestApp } from "./create-test-app";
import { createTestApp } from "./create-test-app";

/** Mirrors `create-test-app.ts`'s own constraint; not part of the public surface. */
type Plugins = PluginData<PluginConstructor, unknown, string>[];

/**
 * The handle {@link useTestApp} returns: a live accessor for the harness app
 * booted for the current test.
 */
export interface TestAppHandle<T extends Plugins> {
  /**
   * The app booted for the current test. Read it inside a test body — each
   * `beforeEach` boots a fresh app and each `afterEach` closes it.
   */
  readonly current: TestApp<T>;
}

/**
 * Boot a harness app before each test and close it after, so a suite that needs
 * an app per test never hand-wires the hooks or risks a forgotten `close()`.
 *
 * Mirrors {@link useServiceContextMock} and {@link useTestCache}: call it at the
 * top of a `describe` block (or module top-level), NOT inside a test — Vitest
 * registers `beforeEach`/`afterEach` during collection.
 *
 * Reach for this when the app must outlive a single expression. `await using`
 * covers one test more concisely, but it cannot carry an app from a `beforeEach`
 * into the test body, and the harness allows only one open app at a time — so a
 * `describe` that holds one in `beforeAll` cannot contain a test that boots its
 * own.
 *
 * @example
 * ```ts
 * describe("my plugin over HTTP", () => {
 *   const app = useTestApp({
 *     plugins: [myPlugin()],
 *     responses: { "jobs.getRun": { state: "TERMINATED" } },
 *   });
 *
 *   test("answers a request", async () => {
 *     const res = await app.current.post("/api/my-plugin/run", { body: { id: 1 } });
 *     expect(res.status).toBe(200);
 *   });
 * });
 * ```
 *
 * @param options - Passed to {@link createTestApp} unchanged, for every boot.
 * @returns `{ current }` — the app booted for the current test.
 */
export function useTestApp<T extends Plugins>(
  options: CreateTestAppOptions<T> = {},
): TestAppHandle<T> {
  let app: TestApp<T> | undefined;

  beforeEach(async () => {
    app = await createTestApp(options);
  });

  afterEach(async () => {
    const booted = app;
    // Cleared before the await so a close that throws cannot leave a stale
    // handle readable by the next test.
    app = undefined;
    await booted?.close();
  });

  return {
    get current(): TestApp<T> {
      if (!app) {
        throw new Error(
          "useTestApp: no active app. Call useTestApp() at the top of a " +
            "describe block (not inside a test), and read `.current` from " +
            "within a test.",
        );
      }
      return app;
    },
  };
}
