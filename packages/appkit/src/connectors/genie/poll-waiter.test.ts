import { describe, expect, test, vi } from "vitest";
import { type Pollable, type PollEvent, pollWaiter } from "./poll-waiter";

function createMockWaiter<P>(opts: {
  progressValues?: P[];
  result: P;
  error?: Error;
  delay?: number;
}): Pollable<P> {
  return {
    wait: vi.fn().mockImplementation(async (options: any = {}) => {
      if (opts.progressValues) {
        for (const value of opts.progressValues) {
          if (opts.delay) {
            await new Promise((r) => setTimeout(r, opts.delay));
          }
          if (options.onProgress) {
            await options.onProgress(value);
          }
        }
      }
      if (opts.error) throw opts.error;
      return opts.result;
    }),
  };
}

async function collect<P>(
  gen: AsyncGenerator<PollEvent<P>>,
): Promise<PollEvent<P>[]> {
  const events: PollEvent<P>[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

describe("pollWaiter", () => {
  test("yields progress events then completed", async () => {
    const waiter = createMockWaiter({
      progressValues: [{ status: "A" }, { status: "B" }],
      result: { status: "DONE" },
    });

    const events = await collect(pollWaiter(waiter));

    expect(events).toEqual([
      { type: "progress", value: { status: "A" } },
      { type: "progress", value: { status: "B" } },
      { type: "completed", value: { status: "DONE" } },
    ]);
  });

  test("yields only completed when no progress events", async () => {
    const waiter = createMockWaiter({
      result: { value: 42 },
    });

    const events = await collect(pollWaiter(waiter));

    expect(events).toEqual([{ type: "completed", value: { value: 42 } }]);
  });

  test("throws when waiter rejects", async () => {
    const waiter = createMockWaiter({
      result: null as any,
      error: new Error("boom"),
    });

    const events: PollEvent<any>[] = [];
    await expect(async () => {
      for await (const event of pollWaiter(waiter)) {
        events.push(event);
      }
    }).rejects.toThrow("boom");

    expect(events).toEqual([]);
  });

  test("throws after yielding progress if waiter fails mid-poll", async () => {
    const waiter = createMockWaiter({
      progressValues: [{ status: "A" }],
      result: null as any,
      error: new Error("mid-poll failure"),
    });

    const events: PollEvent<any>[] = [];
    await expect(async () => {
      for await (const event of pollWaiter(waiter)) {
        events.push(event);
      }
    }).rejects.toThrow("mid-poll failure");

    expect(events).toEqual([{ type: "progress", value: { status: "A" } }]);
  });

  test("handles async delays between progress callbacks", async () => {
    const waiter = createMockWaiter({
      progressValues: [{ n: 1 }, { n: 2 }, { n: 3 }],
      result: { n: 99 },
      delay: 10,
    });

    const events = await collect(pollWaiter(waiter));

    expect(events).toHaveLength(4);
    expect(events[0]).toEqual({ type: "progress", value: { n: 1 } });
    expect(events[1]).toEqual({ type: "progress", value: { n: 2 } });
    expect(events[2]).toEqual({ type: "progress", value: { n: 3 } });
    expect(events[3]).toEqual({ type: "completed", value: { n: 99 } });
  });

  test("passes timeout option through to waiter.wait()", async () => {
    const waiter = createMockWaiter({
      result: { done: true },
    });

    const timeoutValue = { ms: 5000 };
    await collect(pollWaiter(waiter, { timeout: timeoutValue }));

    expect(waiter.wait).toHaveBeenCalledWith(
      expect.objectContaining({ timeout: timeoutValue }),
    );
  });
});
