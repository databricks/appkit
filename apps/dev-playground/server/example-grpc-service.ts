/**
 * Example gRPC service implementation using the proto-defined JobDataService.
 *
 * This demonstrates how to implement a gRPC service that can be registered
 * with the proto plugin and accessed by clients (browser via Connect,
 * or native gRPC from Python/Go).
 *
 * Usage:
 *   import { proto } from "@databricks/appkit";
 *   import { jobDataServiceImpl } from "./example-grpc-service";
 *   import { JobDataService } from "shared/proto/appkit/v1/services_pb";
 *
 *   const appkit = await createApp({
 *     plugins: [
 *       proto({
 *         services: [{ service: JobDataService, implementation: jobDataServiceImpl }],
 *       }),
 *     ],
 *   });
 */

import type { JobStatus } from "shared";

// Example in-memory store for job results
const mockJobResults = new Map<
  string,
  {
    jobRunId: string;
    jobId: string;
    status: number;
    rows: Array<{ fields: Record<string, { case: string; value: unknown }> }>;
  }
>();

// Seed some mock data
mockJobResults.set("run-001", {
  jobRunId: "run-001",
  jobId: "job-pipeline-etl",
  status: 3, // SUCCESS
  rows: [
    {
      fields: {
        name: { case: "stringValue", value: "Alice" },
        score: { case: "numberValue", value: 95.5 },
        passed: { case: "boolValue", value: true },
      },
    },
    {
      fields: {
        name: { case: "stringValue", value: "Bob" },
        score: { case: "numberValue", value: 82.3 },
        passed: { case: "boolValue", value: true },
      },
    },
  ],
});

/**
 * Example implementation of the JobDataService.
 *
 * In production, this would query Databricks Jobs API or read
 * proto-serialized results from UC Volumes.
 */
export const jobDataServiceImpl = {
  async getJobResult(request: { jobRunId: string }) {
    const result = mockJobResults.get(request.jobRunId);
    if (!result) {
      throw new Error(`Job run "${request.jobRunId}" not found`);
    }
    return result;
  },

  async *streamJobResults(request: { jobId: string }) {
    // Stream all results matching the job ID
    for (const [, result] of mockJobResults) {
      if (result.jobId === request.jobId) {
        yield result;
      }
    }
  },

  async submitBatch(request: { batch?: { batchId: string } }) {
    return {
      accepted: true,
      batchId: request.batch?.batchId ?? "generated-batch-id",
    };
  },
};
