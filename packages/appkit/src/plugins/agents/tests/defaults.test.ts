import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { RetryInterceptor } from "../../../plugin/interceptors/retry";
import type { InterceptorContext } from "../../../plugin/interceptors/types";
import { agentStreamDefaults } from "../defaults";

describe("agentStreamDefaults", () => {
  const retry = agentStreamDefaults.default.retry;
  if (!retry) throw new Error("expected a retry default");

  test("enables a conservative retry default for transient errors", () => {
    expect(retry.enabled).toBe(true);
    // Conservative: at most one extra attempt, with bounded backoff.
    expect(retry.attempts).toBe(2);
    expect(retry.initialDelay).toBeGreaterThan(0);
    expect(retry.maxDelay).toBeGreaterThanOrEqual(retry.initialDelay ?? 0);
    // Cap keeps a serving outage from snowballing into long stalls.
    expect(retry.maxDelay).toBeLessThanOrEqual(10_000);
  });

  describe("streaming-replay safety", () => {
    let context: InterceptorContext;

    beforeEach(() => {
      context = { metadata: new Map(), userKey: "test" };
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    test("does NOT re-run a streamed turn or re-execute tools when an error is thrown mid-iteration", async () => {
      // Retry wraps generator *construction* only (see the SAFETY note in
      // defaults.ts); the assertions below prove the body runs once and no
      // token or tool side-effect is replayed.
      const interceptor = new RetryInterceptor(retry);

      let generatorBodyRuns = 0;
      const toolSideEffect = vi.fn();

      async function* turn() {
        generatorBodyRuns++;
        toolSideEffect("emit-token-1");
        yield "token-1";
        // Transient 5xx surfacing AFTER the first streamed event.
        throw Object.assign(new Error("serving blip"), { statusCode: 500 });
      }

      // executeStream's wrappedFn: `async () => fn(signal)`.
      const wrappedFn = async () => turn();

      const result = await interceptor.intercept(wrappedFn, context);

      // Generator body has not run yet — only constructed.
      expect(generatorBodyRuns).toBe(0);
      expect(toolSideEffect).not.toHaveBeenCalled();

      // Now drive iteration (the part that lives outside the interceptor).
      const seen: string[] = [];
      await expect(
        (async () => {
          for await (const ev of result) seen.push(ev);
        })(),
      ).rejects.toThrow("serving blip");

      // The transient error during iteration was NOT retried: the body ran
      // exactly once and the side-effect fired exactly once. No replay.
      expect(generatorBodyRuns).toBe(1);
      expect(toolSideEffect).toHaveBeenCalledTimes(1);
      expect(seen).toEqual(["token-1"]);
    });

    test("retries a transient failure during generator SETUP (before output)", async () => {
      // The one place the streaming retry default genuinely helps: a transient
      // error thrown synchronously while constructing the turn, before any
      // event is emitted, is safe to retry.
      const interceptor = new RetryInterceptor(retry);

      const setup = vi
        .fn<() => Promise<AsyncGenerator<string>>>()
        .mockRejectedValueOnce(
          Object.assign(new Error("setup blip"), { statusCode: 503 }),
        )
        .mockResolvedValue(
          (async function* () {
            yield "ok";
          })(),
        );

      const promise = interceptor.intercept(setup, context);
      await vi.runAllTimersAsync();
      await promise;

      expect(setup).toHaveBeenCalledTimes(2);
    });
  });
});
