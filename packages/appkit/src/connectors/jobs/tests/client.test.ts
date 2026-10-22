import { describe, expect, test, vi } from "vitest";

import { JobsConnector } from "../client";

// The modular Jobs SDK types int64s as `bigint`, which `JSON.stringify` rejects.
// Every connector response ends up in HTTP JSON, SSE or the cache.
describe("JobsConnector", () => {
  test("getRun returns a JSON-serializable run with numeric int64s", async () => {
    const getRun = vi.fn().mockResolvedValue({
      runId: 9007199254740991n,
      jobId: 123n,
      startTime: 1700000000000n,
      state: { lifeCycleState: "TERMINATED" },
      tasks: [{ taskKey: "t1", attemptNumber: 0n }],
    });
    const client = { jobs: { getRun } } as never;

    const run = await new JobsConnector({}).getRun(client, { runId: 42n });

    expect(getRun).toHaveBeenCalledWith({ runId: 42n }, { signal: undefined });
    expect(JSON.parse(JSON.stringify(run))).toEqual({
      runId: 9007199254740991,
      jobId: 123,
      startTime: 1700000000000,
      state: { lifeCycleState: "TERMINATED" },
      tasks: [{ taskKey: "t1", attemptNumber: 0 }],
    });
  });

  test("runNow returns the waiter's runId as a number", async () => {
    const runNow = vi.fn().mockResolvedValue({ runId: 7n });
    const client = { jobs: { runNow } } as never;

    const result = await new JobsConnector({}).runNow(client, { jobId: 123n });

    expect(result).toEqual({ runId: 7 });
  });

  test("surfaces the modular ApiError's httpStatusCode as statusCode", async () => {
    // Shaped like sdk-core's ApiError: the status is a getter, not `statusCode`.
    class ModularApiError extends Error {
      get httpStatusCode() {
        return 404;
      }
    }
    const getRun = vi.fn().mockRejectedValue(new ModularApiError("not found"));
    const client = { jobs: { getRun } } as never;

    await expect(
      new JobsConnector({}).getRun(client, { runId: 1n }),
    ).rejects.toMatchObject({ statusCode: 404, message: "not found" });
  });
});
