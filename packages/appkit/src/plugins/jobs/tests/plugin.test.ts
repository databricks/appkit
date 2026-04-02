import { mockServiceContext, setupDatabricksEnv } from "@tools/test-helpers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ServiceContext } from "../../../context/service-context";
import { AuthenticationError } from "../../../errors";
import { ResourceType } from "../../../registry";
import { JobsPlugin, jobs } from "../plugin";

const { mockClient, mockCacheInstance } = vi.hoisted(() => {
  const mockJobsApi = {
    runNow: vi.fn(),
    submit: vi.fn(),
    getRun: vi.fn(),
    getRunOutput: vi.fn(),
    cancelRun: vi.fn(),
    listRuns: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
  };

  const mockClient = {
    jobs: mockJobsApi,
    config: {
      host: "https://test.databricks.com",
      authenticate: vi.fn(),
    },
  };

  const mockCacheInstance = {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    getOrExecute: vi.fn(async (_key: unknown[], fn: () => Promise<unknown>) =>
      fn(),
    ),
    generateKey: vi.fn(),
  };

  return { mockJobsApi, mockClient, mockCacheInstance };
});

vi.mock("@databricks/sdk-experimental", () => ({
  WorkspaceClient: vi.fn(() => mockClient),
  Context: vi.fn(),
}));

vi.mock("../../../context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../context")>();
  return {
    ...actual,
    getWorkspaceClient: vi.fn(() => mockClient),
    isInUserContext: vi.fn(() => true),
  };
});

vi.mock("../../../cache", () => ({
  CacheManager: {
    getInstanceSync: vi.fn(() => mockCacheInstance),
  },
}));

describe("JobsPlugin", () => {
  let serviceContextMock: Awaited<ReturnType<typeof mockServiceContext>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    setupDatabricksEnv();
    ServiceContext.reset();
    serviceContextMock = await mockServiceContext();
  });

  afterEach(() => {
    serviceContextMock?.restore();
    delete process.env.DATABRICKS_JOB_ID;
    delete process.env.DATABRICKS_JOB_ETL;
    delete process.env.DATABRICKS_JOB_ML;
    delete process.env.DATABRICKS_JOB_;
    delete process.env.DATABRICKS_JOB_EMPTY;
    delete process.env.DATABRICKS_JOB_MY_PIPELINE;
  });

  test('plugin name is "jobs"', () => {
    const pluginData = jobs({});
    expect(pluginData.name).toBe("jobs");
  });

  test("plugin instance has correct name", () => {
    process.env.DATABRICKS_JOB_ETL = "123";
    const plugin = new JobsPlugin({});
    expect(plugin.name).toBe("jobs");
  });

  describe("discoverJobs", () => {
    test("discovers jobs from DATABRICKS_JOB_* env vars", () => {
      process.env.DATABRICKS_JOB_ETL = "123";
      process.env.DATABRICKS_JOB_ML = "456";

      const jobs = JobsPlugin.discoverJobs({});
      expect(jobs).toHaveProperty("etl");
      expect(jobs).toHaveProperty("ml");
      expect(jobs.etl).toEqual({});
      expect(jobs.ml).toEqual({});
    });

    test("single-job case: DATABRICKS_JOB_ID maps to 'default' key", () => {
      process.env.DATABRICKS_JOB_ID = "789";

      const jobs = JobsPlugin.discoverJobs({});
      expect(jobs).toHaveProperty("default");
      expect(Object.keys(jobs)).toEqual(["default"]);
    });

    test("DATABRICKS_JOB_ID is ignored when named jobs exist", () => {
      process.env.DATABRICKS_JOB_ID = "789";
      process.env.DATABRICKS_JOB_ETL = "123";

      const jobs = JobsPlugin.discoverJobs({});
      expect(jobs).not.toHaveProperty("default");
      expect(jobs).toHaveProperty("etl");
    });

    test("DATABRICKS_JOB_ID is ignored when explicit config exists", () => {
      process.env.DATABRICKS_JOB_ID = "789";

      const jobs = JobsPlugin.discoverJobs({
        jobs: { pipeline: {} },
      });
      expect(jobs).not.toHaveProperty("default");
      expect(jobs).toHaveProperty("pipeline");
    });

    test("merges with explicit config, explicit wins", () => {
      process.env.DATABRICKS_JOB_ETL = "123";
      process.env.DATABRICKS_JOB_ML = "456";

      const jobs = JobsPlugin.discoverJobs({
        jobs: {
          etl: { timeout: 42 },
        },
      });
      expect(jobs.etl).toEqual({ timeout: 42 });
      expect(jobs.ml).toEqual({});
    });

    test("skips bare DATABRICKS_JOB_ prefix (no suffix)", () => {
      process.env.DATABRICKS_JOB_ = "999";
      try {
        const jobs = JobsPlugin.discoverJobs({});
        expect(Object.keys(jobs)).not.toContain("");
      } finally {
        delete process.env.DATABRICKS_JOB_;
      }
    });

    test("skips empty env var values", () => {
      process.env.DATABRICKS_JOB_EMPTY = "";
      try {
        const jobs = JobsPlugin.discoverJobs({});
        expect(jobs).not.toHaveProperty("empty");
      } finally {
        delete process.env.DATABRICKS_JOB_EMPTY;
      }
    });

    test("lowercases env var suffix", () => {
      process.env.DATABRICKS_JOB_MY_PIPELINE = "111";
      try {
        const jobs = JobsPlugin.discoverJobs({});
        expect(jobs).toHaveProperty("my_pipeline");
      } finally {
        delete process.env.DATABRICKS_JOB_MY_PIPELINE;
      }
    });

    test("returns only explicit jobs when no env vars match", () => {
      const jobs = JobsPlugin.discoverJobs({
        jobs: { custom: { timeout: 10 } },
      });
      expect(Object.keys(jobs)).toEqual(["custom"]);
    });
  });

  describe("getResourceRequirements", () => {
    test("generates one resource per job key", () => {
      process.env.DATABRICKS_JOB_ETL = "123";
      process.env.DATABRICKS_JOB_ML = "456";

      const requirements = JobsPlugin.getResourceRequirements({});
      expect(requirements).toHaveLength(2);

      const etlReq = requirements.find((r) => r.resourceKey === "job-etl");
      expect(etlReq).toBeDefined();
      expect(etlReq?.type).toBe(ResourceType.JOB);
      expect(etlReq?.permission).toBe("CAN_MANAGE_RUN");
      expect(etlReq?.fields.id.env).toBe("DATABRICKS_JOB_ETL");
      expect(etlReq?.required).toBe(true);

      const mlReq = requirements.find((r) => r.resourceKey === "job-ml");
      expect(mlReq).toBeDefined();
      expect(mlReq?.fields.id.env).toBe("DATABRICKS_JOB_ML");
    });

    test("single-job case uses DATABRICKS_JOB_ID env var", () => {
      process.env.DATABRICKS_JOB_ID = "789";

      const requirements = JobsPlugin.getResourceRequirements({});
      expect(requirements).toHaveLength(1);
      expect(requirements[0].resourceKey).toBe("job-default");
      expect(requirements[0].fields.id.env).toBe("DATABRICKS_JOB_ID");
    });

    test("returns empty array when no jobs configured and no env vars", () => {
      const requirements = JobsPlugin.getResourceRequirements({ jobs: {} });
      expect(requirements).toHaveLength(0);
    });

    test("auto-discovers jobs from env vars with empty config", () => {
      process.env.DATABRICKS_JOB_ETL = "123";
      process.env.DATABRICKS_JOB_ML = "456";

      const requirements = JobsPlugin.getResourceRequirements({});
      expect(requirements).toHaveLength(2);
      expect(requirements.map((r) => r.resourceKey).sort()).toEqual([
        "job-etl",
        "job-ml",
      ]);
    });
  });

  describe("exports()", () => {
    test("returns a callable function with a .job alias", () => {
      process.env.DATABRICKS_JOB_ETL = "123";

      const plugin = new JobsPlugin({});
      const exported = plugin.exports();

      expect(typeof exported).toBe("function");
      expect(typeof exported.job).toBe("function");
    });

    test("returns job handle with asUser and direct JobAPI methods", () => {
      process.env.DATABRICKS_JOB_ETL = "123";

      const plugin = new JobsPlugin({});
      const exported = plugin.exports();

      const handle = exported("etl");
      expect(typeof handle.asUser).toBe("function");
      expect(typeof handle.runNow).toBe("function");
      expect(typeof handle.runNowAndWait).toBe("function");
      expect(typeof handle.lastRun).toBe("function");
      expect(typeof handle.listRuns).toBe("function");
      expect(typeof handle.getRun).toBe("function");
      expect(typeof handle.getRunOutput).toBe("function");
      expect(typeof handle.cancelRun).toBe("function");
      expect(typeof handle.getJob).toBe("function");
    });

    test(".job() returns the same shape as the callable", () => {
      process.env.DATABRICKS_JOB_ETL = "123";

      const plugin = new JobsPlugin({});
      const exported = plugin.exports();

      const direct = exported("etl");
      const viaJob = exported.job("etl");

      expect(Object.keys(direct).sort()).toEqual(Object.keys(viaJob).sort());
    });

    test("throws for unknown job key", () => {
      process.env.DATABRICKS_JOB_ETL = "123";

      const plugin = new JobsPlugin({});
      const exported = plugin.exports();

      expect(() => exported("unknown")).toThrow(/Unknown job "unknown"/);
      expect(() => exported.job("unknown")).toThrow(/Unknown job "unknown"/);
    });

    test("single-job default key is accessible", () => {
      process.env.DATABRICKS_JOB_ID = "789";

      const plugin = new JobsPlugin({});
      const exported = plugin.exports();

      expect(() => exported("default")).not.toThrow();
      const handle = exported("default");
      expect(typeof handle.runNow).toBe("function");
    });
  });

  describe("runNow auto-fills job_id", () => {
    test("runNow passes configured job_id to connector", async () => {
      process.env.DATABRICKS_JOB_ETL = "123";

      mockClient.jobs.runNow.mockResolvedValue({
        response: { run_id: 42 },
      });

      const plugin = new JobsPlugin({});
      const exported = plugin.exports();
      const handle = exported("etl");

      await handle.runNow();

      expect(mockClient.jobs.runNow).toHaveBeenCalledWith(
        expect.objectContaining({ job_id: 123 }),
        expect.anything(),
      );
    });

    test("runNow merges user params with configured job_id", async () => {
      process.env.DATABRICKS_JOB_ETL = "123";

      mockClient.jobs.runNow.mockResolvedValue({
        response: { run_id: 42 },
      });

      const plugin = new JobsPlugin({});
      const exported = plugin.exports();
      const handle = exported("etl");

      await handle.runNow({
        notebook_params: { key: "value" },
      } as any);

      expect(mockClient.jobs.runNow).toHaveBeenCalledWith(
        expect.objectContaining({
          job_id: 123,
          notebook_params: { key: "value" },
        }),
        expect.anything(),
      );
    });
  });

  describe("OBO and service principal access", () => {
    test("job handle exposes asUser and all JobAPI methods", () => {
      process.env.DATABRICKS_JOB_ETL = "123";

      const plugin = new JobsPlugin({});
      const handle = plugin.exports()("etl");

      expect(typeof handle.asUser).toBe("function");

      const jobMethods = [
        "runNow",
        "runNowAndWait",
        "lastRun",
        "listRuns",
        "getRun",
        "getRunOutput",
        "cancelRun",
        "getJob",
      ];
      for (const method of jobMethods) {
        expect(typeof (handle as any)[method]).toBe("function");
      }
    });

    test("asUser throws AuthenticationError without token in production", () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";
      process.env.DATABRICKS_JOB_ETL = "123";

      try {
        const plugin = new JobsPlugin({});
        const handle = plugin.exports()("etl");
        const mockReq = { header: () => undefined } as any;

        expect(() => handle.asUser(mockReq)).toThrow(AuthenticationError);
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });

    test("asUser in dev mode returns JobAPI with all methods", () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = "development";
      process.env.DATABRICKS_JOB_ETL = "123";

      try {
        const plugin = new JobsPlugin({});
        const handle = plugin.exports()("etl");
        const mockReq = { header: () => undefined } as any;
        const api = handle.asUser(mockReq);

        const jobMethods = [
          "runNow",
          "runNowAndWait",
          "lastRun",
          "listRuns",
          "getRun",
          "getRunOutput",
          "cancelRun",
          "getJob",
        ];
        for (const method of jobMethods) {
          expect(typeof (api as any)[method]).toBe("function");
        }
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });
  });

  describe("clientConfig", () => {
    test("returns configured job keys", () => {
      process.env.DATABRICKS_JOB_ETL = "123";
      process.env.DATABRICKS_JOB_ML = "456";

      const plugin = new JobsPlugin({});
      const config = plugin.clientConfig();

      expect(config).toEqual({ jobs: ["etl", "ml"] });
    });

    test("returns single default key for DATABRICKS_JOB_ID", () => {
      process.env.DATABRICKS_JOB_ID = "789";

      const plugin = new JobsPlugin({});
      const config = plugin.clientConfig();

      expect(config).toEqual({ jobs: ["default"] });
    });

    test("returns empty array when no jobs configured", () => {
      const plugin = new JobsPlugin({});
      const config = plugin.clientConfig();

      expect(config).toEqual({ jobs: [] });
    });
  });

  describe("auto-discovery integration", () => {
    test("jobs() with no config discovers from env vars", () => {
      process.env.DATABRICKS_JOB_ETL = "123";

      const plugin = new JobsPlugin({});
      const exported = plugin.exports();
      expect(() => exported("etl")).not.toThrow();
    });

    test("jobs() with no config and no env vars creates no jobs", () => {
      const plugin = new JobsPlugin({});
      const exported = plugin.exports();
      expect(() => exported("etl")).toThrow(/Unknown job/);
    });
  });

  describe("multi-job case", () => {
    test("supports multiple configured jobs", () => {
      process.env.DATABRICKS_JOB_ETL = "100";
      process.env.DATABRICKS_JOB_ML = "200";

      const plugin = new JobsPlugin({});
      const exported = plugin.exports();

      expect(() => exported("etl")).not.toThrow();
      expect(() => exported("ml")).not.toThrow();
      expect(() => exported("other")).toThrow(/Unknown job "other"/);
    });

    test("each job has its own job_id", async () => {
      process.env.DATABRICKS_JOB_ETL = "100";
      process.env.DATABRICKS_JOB_ML = "200";

      mockClient.jobs.runNow.mockResolvedValue({
        response: { run_id: 1 },
      });

      const plugin = new JobsPlugin({});
      const exported = plugin.exports();

      await exported("etl").runNow();
      expect(mockClient.jobs.runNow).toHaveBeenCalledWith(
        expect.objectContaining({ job_id: 100 }),
        expect.anything(),
      );

      mockClient.jobs.runNow.mockClear();

      await exported("ml").runNow();
      expect(mockClient.jobs.runNow).toHaveBeenCalledWith(
        expect.objectContaining({ job_id: 200 }),
        expect.anything(),
      );
    });
  });
});
