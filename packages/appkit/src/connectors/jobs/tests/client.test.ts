import { describe, expect, test, vi } from "vitest";

import { JobsConnector } from "../client";

// The modular Jobs SDK returns camelCase models with `bigint` int64s, which
// `JSON.stringify` rejects. The connector must hand the plugin the legacy wire
// shape (snake_case, `number`) its public HTTP/SSE/cache surface has always had.
describe("JobsConnector wire-shape translation", () => {
  test("getRun returns a JSON-serializable snake_case run with numeric IDs", async () => {
    const getRun = vi.fn().mockResolvedValue({
      runId: 9007199254740991n,
      jobId: 123n,
      startTime: 1700000000000n,
      state: { lifeCycleState: "TERMINATED" },
      overridingParameters: { notebookParams: { myParam: "x" } },
      tasks: [
        {
          taskKey: "t1",
          pipelineTask: { pipelineTaskParameters: { fullRefresh: "true" } },
        },
      ],
    });
    const client = { jobs: { getRun } } as never;

    const run = await new JobsConnector({}).getRun(client, { run_id: 42 });

    expect(getRun).toHaveBeenCalledWith({ runId: 42n }, { signal: undefined });
    expect(JSON.parse(JSON.stringify(run))).toEqual({
      run_id: 9007199254740991,
      job_id: 123,
      start_time: 1700000000000,
      state: { life_cycle_state: "TERMINATED" },
      // Map keys are user data: copied verbatim, not re-cased.
      overriding_parameters: { notebook_params: { myParam: "x" } },
      tasks: [
        {
          task_key: "t1",
          pipeline_task: { parameters: { fullRefresh: "true" } },
        },
      ],
    });
  });

  test("runNow camelCases the request without touching param keys", async () => {
    const runNow = vi.fn().mockResolvedValue({ runId: 7n });
    const client = { jobs: { runNow } } as never;

    const result = await new JobsConnector({}).runNow(client, {
      job_id: 123,
      notebook_params: { my_param: "v" },
    });

    expect(runNow).toHaveBeenCalledWith(
      { jobId: 123n, notebookParams: { my_param: "v" } },
      { signal: undefined },
    );
    expect(result).toEqual({ run_id: 7, number_in_job: 7 });
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
      new JobsConnector({}).getRun(client, { run_id: 1 }),
    ).rejects.toMatchObject({ statusCode: 404, message: "not found" });
  });
});
