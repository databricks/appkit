import { mockServiceContext, setupDatabricksEnv } from "@tools/test-helpers";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { ServiceContext } from "../../../context/service-context";
import { AuthenticationError } from "../../../errors";
import { ResourceType } from "../../../registry";
import {
  JOBS_READ_DEFAULTS,
  JOBS_STREAM_DEFAULTS,
  JOBS_WRITE_DEFAULTS,
} from "../defaults";
import { mapParams } from "../params";
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
      expect(typeof handle.runAndWait).toBe("function");
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

      mockClient.jobs.runNow.mockResolvedValue({ run_id: 42 });

      const plugin = new JobsPlugin({});
      const exported = plugin.exports();
      const handle = exported("etl");

      await handle.runNow();

      expect(mockClient.jobs.runNow).toHaveBeenCalledWith(
        expect.objectContaining({ job_id: 123 }),
        expect.anything(),
      );
    });

    test("runNow merges user params with configured job_id (no taskType)", async () => {
      process.env.DATABRICKS_JOB_ETL = "123";

      mockClient.jobs.runNow.mockResolvedValue({ run_id: 42 });

      const plugin = new JobsPlugin({});
      const exported = plugin.exports();
      const handle = exported("etl");

      await handle.runNow({
        notebook_params: { key: "value" },
      });

      expect(mockClient.jobs.runNow).toHaveBeenCalledWith(
        expect.objectContaining({
          job_id: 123,
          notebook_params: { key: "value" },
        }),
        expect.anything(),
      );
    });
  });

  describe("parameter validation (Phase 3)", () => {
    test("runNow validates params against job config schema", async () => {
      process.env.DATABRICKS_JOB_ETL = "123";

      const plugin = new JobsPlugin({
        jobs: {
          etl: {
            taskType: "notebook",
            params: z.object({ key: z.string() }),
          },
        },
      });
      const handle = plugin.exports()("etl");

      await expect(handle.runNow({ key: 42 })).rejects.toThrow(
        /Parameter validation failed for job "etl"/,
      );
    });

    test("runNow maps validated params to SDK fields when taskType is set", async () => {
      process.env.DATABRICKS_JOB_ETL = "123";

      mockClient.jobs.runNow.mockResolvedValue({ run_id: 42 });

      const plugin = new JobsPlugin({
        jobs: {
          etl: {
            taskType: "notebook",
            params: z.object({ key: z.string() }),
          },
        },
      });
      const handle = plugin.exports()("etl");

      await handle.runNow({ key: "value" });

      expect(mockClient.jobs.runNow).toHaveBeenCalledWith(
        expect.objectContaining({
          job_id: 123,
          notebook_params: { key: "value" },
        }),
        expect.anything(),
      );
    });

    test("runNow skips validation when no schema is configured", async () => {
      process.env.DATABRICKS_JOB_ETL = "123";

      mockClient.jobs.runNow.mockResolvedValue({ run_id: 42 });

      const plugin = new JobsPlugin({});
      const handle = plugin.exports()("etl");

      await expect(handle.runNow({ anything: "goes" })).resolves.not.toThrow();
    });
  });

  describe("read operations use interceptors", () => {
    test("getRun wraps call in execute", async () => {
      process.env.DATABRICKS_JOB_ETL = "123";

      mockClient.jobs.getRun.mockResolvedValue({
        run_id: 1,
        state: { life_cycle_state: "TERMINATED" },
      });

      const plugin = new JobsPlugin({});
      const executeSpy = vi.spyOn(plugin as any, "execute");
      const handle = plugin.exports()("etl");

      await handle.getRun(1);

      expect(executeSpy).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({
          default: expect.objectContaining({
            cache: expect.objectContaining({
              cacheKey: ["jobs:getRun", "etl", 1],
            }),
          }),
        }),
      );
    });

    test("getJob wraps call in execute", async () => {
      process.env.DATABRICKS_JOB_ETL = "123";

      mockClient.jobs.get.mockResolvedValue({ job_id: 123 });

      const plugin = new JobsPlugin({});
      const executeSpy = vi.spyOn(plugin as any, "execute");
      const handle = plugin.exports()("etl");

      await handle.getJob();

      expect(executeSpy).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({
          default: expect.objectContaining({
            cache: expect.objectContaining({
              cacheKey: ["jobs:getJob", "etl"],
            }),
          }),
        }),
      );
    });

    test("cancelRun wraps call in execute with write defaults", async () => {
      process.env.DATABRICKS_JOB_ETL = "123";

      mockClient.jobs.cancelRun.mockResolvedValue(undefined);

      const plugin = new JobsPlugin({});
      const executeSpy = vi.spyOn(plugin as any, "execute");
      const handle = plugin.exports()("etl");

      await handle.cancelRun(1);

      expect(executeSpy).toHaveBeenCalledWith(expect.any(Function), {
        default: JOBS_WRITE_DEFAULTS,
      });
    });
  });

  describe("runAndWait polling", () => {
    test("runAndWait yields status updates and terminates on TERMINATED", async () => {
      process.env.DATABRICKS_JOB_ETL = "123";

      mockClient.jobs.runNow.mockResolvedValue({ run_id: 42 });
      mockClient.jobs.getRun
        .mockResolvedValueOnce({
          run_id: 42,
          state: { life_cycle_state: "RUNNING" },
        })
        .mockResolvedValueOnce({
          run_id: 42,
          state: { life_cycle_state: "TERMINATED" },
        });

      const plugin = new JobsPlugin({ pollIntervalMs: 10 });
      const handle = plugin.exports()("etl");

      const statuses: any[] = [];
      for await (const status of handle.runAndWait()) {
        statuses.push(status);
      }

      expect(statuses).toHaveLength(2);
      expect(statuses[0].status).toBe("RUNNING");
      expect(statuses[1].status).toBe("TERMINATED");
    });

    test("runAndWait throws when runNow returns no run_id", async () => {
      process.env.DATABRICKS_JOB_ETL = "123";

      mockClient.jobs.runNow.mockResolvedValue({});

      const plugin = new JobsPlugin({});
      const handle = plugin.exports()("etl");

      const gen = handle.runAndWait();
      await expect(gen.next()).rejects.toThrow(
        "runNow did not return a run_id",
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
        "runAndWait",
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
          "runAndWait",
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
    test("returns configured job keys with params schema", () => {
      process.env.DATABRICKS_JOB_ETL = "123";
      process.env.DATABRICKS_JOB_ML = "456";

      const plugin = new JobsPlugin({});
      const config = plugin.clientConfig();

      expect(config).toEqual({
        jobs: {
          etl: { params: null },
          ml: { params: null },
        },
      });
    });

    test("returns single default key for DATABRICKS_JOB_ID", () => {
      process.env.DATABRICKS_JOB_ID = "789";

      const plugin = new JobsPlugin({});
      const config = plugin.clientConfig();

      expect(config).toEqual({
        jobs: {
          default: { params: null },
        },
      });
    });

    test("returns empty object when no jobs configured", () => {
      const plugin = new JobsPlugin({});
      const config = plugin.clientConfig();

      expect(config).toEqual({ jobs: {} });
    });

    test("includes JSON schema when params schema is configured", () => {
      process.env.DATABRICKS_JOB_ETL = "123";

      const plugin = new JobsPlugin({
        jobs: {
          etl: {
            params: z.object({ key: z.string() }),
          },
        },
      });
      const config = plugin.clientConfig();
      const etlConfig = (config.jobs as any).etl;

      expect(etlConfig.params).toBeDefined();
      expect(etlConfig.params).not.toBeNull();
      expect(etlConfig.params.type).toBe("object");
      expect(etlConfig.params.properties).toHaveProperty("key");
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

      mockClient.jobs.runNow.mockResolvedValue({ run_id: 1 });

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

describe("defaults", () => {
  test("JOBS_READ_DEFAULTS has expected shape", () => {
    expect(JOBS_READ_DEFAULTS.cache?.enabled).toBe(true);
    expect(JOBS_READ_DEFAULTS.cache?.ttl).toBe(60);
    expect(JOBS_READ_DEFAULTS.retry?.enabled).toBe(true);
    expect(JOBS_READ_DEFAULTS.retry?.attempts).toBe(3);
    expect(JOBS_READ_DEFAULTS.timeout).toBe(30_000);
  });

  test("JOBS_WRITE_DEFAULTS has no cache, no retry", () => {
    expect(JOBS_WRITE_DEFAULTS.cache?.enabled).toBe(false);
    expect(JOBS_WRITE_DEFAULTS.retry?.enabled).toBe(false);
    expect(JOBS_WRITE_DEFAULTS.timeout).toBe(120_000);
  });

  test("JOBS_STREAM_DEFAULTS has extended timeout", () => {
    expect(JOBS_STREAM_DEFAULTS.cache?.enabled).toBe(false);
    expect(JOBS_STREAM_DEFAULTS.retry?.enabled).toBe(false);
    expect(JOBS_STREAM_DEFAULTS.timeout).toBe(600_000);
  });
});

describe("mapParams", () => {
  test("notebook maps to notebook_params with string coercion", () => {
    const result = mapParams("notebook", { key: "value", num: 42 });
    expect(result).toEqual({ notebook_params: { key: "value", num: "42" } });
  });

  test("python_wheel maps to python_named_params", () => {
    const result = mapParams("python_wheel", { arg1: "a", arg2: "b" });
    expect(result).toEqual({ python_named_params: { arg1: "a", arg2: "b" } });
  });

  test("python_script maps to python_params array", () => {
    const result = mapParams("python_script", { args: ["a", "b", "c"] });
    expect(result).toEqual({ python_params: ["a", "b", "c"] });
  });

  test("spark_jar maps to parameters array", () => {
    const result = mapParams("spark_jar", { args: ["x", "y"] });
    expect(result).toEqual({ parameters: ["x", "y"] });
  });

  test("sql maps to parameters Record<string, string>", () => {
    const result = mapParams("sql", { p1: "v1", p2: 42 });
    expect(result).toEqual({ parameters: { p1: "v1", p2: "42" } });
  });

  test("dbt with empty params returns empty object", () => {
    const result = mapParams("dbt", {});
    expect(result).toEqual({});
  });

  test("dbt with params throws error", () => {
    expect(() => mapParams("dbt", { key: "value" })).toThrow(
      "dbt tasks do not accept parameters",
    );
  });

  test("notebook coerces non-string values to string", () => {
    const result = mapParams("notebook", {
      bool: true,
      num: 123,
      nil: "null",
    });
    expect(result).toEqual({
      notebook_params: { bool: "true", num: "123", nil: "null" },
    });
  });
});

describe("injectRoutes", () => {
  let serviceContextMock: Awaited<ReturnType<typeof mockServiceContext>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    setupDatabricksEnv();
    ServiceContext.reset();
    serviceContextMock = await mockServiceContext();
  });

  afterEach(() => {
    serviceContextMock?.restore();
    delete process.env.DATABRICKS_JOB_ETL;
    delete process.env.DATABRICKS_JOB_ML;
  });

  test("registers all 4 routes via this.route()", () => {
    process.env.DATABRICKS_JOB_ETL = "123";

    const plugin = new JobsPlugin({});
    const routeSpy = vi.spyOn(plugin as any, "route");

    const mockRouter = {
      get: vi.fn(),
      post: vi.fn(),
    };

    plugin.injectRoutes(mockRouter as any);

    expect(routeSpy).toHaveBeenCalledTimes(4);

    const routeCalls = routeSpy.mock.calls.map((call) => (call[1] as any).name);
    expect(routeCalls).toContain("run");
    expect(routeCalls).toContain("runs");
    expect(routeCalls).toContain("run-detail");
    expect(routeCalls).toContain("status");
  });

  test("registers correct HTTP methods and paths", () => {
    process.env.DATABRICKS_JOB_ETL = "123";

    const plugin = new JobsPlugin({});
    const routeSpy = vi.spyOn(plugin as any, "route");

    const mockRouter = {
      get: vi.fn(),
      post: vi.fn(),
    };

    plugin.injectRoutes(mockRouter as any);

    const routes = routeSpy.mock.calls.map((call) => ({
      name: (call[1] as any).name,
      method: (call[1] as any).method,
      path: (call[1] as any).path,
    }));

    expect(routes).toContainEqual({
      name: "run",
      method: "post",
      path: "/:jobKey/run",
    });
    expect(routes).toContainEqual({
      name: "runs",
      method: "get",
      path: "/:jobKey/runs",
    });
    expect(routes).toContainEqual({
      name: "run-detail",
      method: "get",
      path: "/:jobKey/runs/:runId",
    });
    expect(routes).toContainEqual({
      name: "status",
      method: "get",
      path: "/:jobKey/status",
    });
  });

  describe("_resolveJob", () => {
    test("returns 404 for unknown job key", () => {
      process.env.DATABRICKS_JOB_ETL = "123";

      const plugin = new JobsPlugin({});
      const resolveJob = (plugin as any)._resolveJob.bind(plugin);

      const mockReq = { params: { jobKey: "unknown" } } as any;
      const mockRes = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      } as any;

      const result = resolveJob(mockReq, mockRes);

      expect(result.jobKey).toBeUndefined();
      expect(mockRes.status).toHaveBeenCalledWith(404);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Unknown job "unknown"',
          plugin: "jobs",
        }),
      );
    });

    test("sanitizes special characters in unknown job key error", () => {
      process.env.DATABRICKS_JOB_ETL = "123";

      const plugin = new JobsPlugin({});
      const resolveJob = (plugin as any)._resolveJob.bind(plugin);

      const mockReq = {
        params: { jobKey: '<script>alert("xss")</script>' },
      } as any;
      const mockRes = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      } as any;

      resolveJob(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Unknown job "scriptalertxssscript"',
        }),
      );
    });

    test("returns jobKey and jobId for known job", () => {
      process.env.DATABRICKS_JOB_ETL = "123";

      const plugin = new JobsPlugin({});
      const resolveJob = (plugin as any)._resolveJob.bind(plugin);

      const mockReq = { params: { jobKey: "etl" } } as any;
      const mockRes = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      } as any;

      const result = resolveJob(mockReq, mockRes);

      expect(result.jobKey).toBe("etl");
      expect(result.jobId).toBe(123);
      expect(mockRes.status).not.toHaveBeenCalled();
    });
  });

  describe("POST /:jobKey/run handler", () => {
    test("returns runId on successful non-streaming run", async () => {
      process.env.DATABRICKS_JOB_ETL = "123";

      mockClient.jobs.runNow.mockResolvedValue({ run_id: 42 });

      const plugin = new JobsPlugin({});
      const routeSpy = vi.spyOn(plugin as any, "route");

      const mockRouter = { get: vi.fn(), post: vi.fn() };
      plugin.injectRoutes(mockRouter as any);

      const runRoute = routeSpy.mock.calls.find(
        (call) => (call[1] as any).name === "run",
      );
      const handler = (runRoute?.[1] as any).handler;

      const mockReq = {
        params: { jobKey: "etl" },
        body: { params: { key: "value" } },
        query: {},
        header: vi.fn().mockReturnValue("test-token"),
      } as any;

      const mockRes = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
        setHeader: vi.fn(),
        flushHeaders: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
      } as any;

      await handler(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalledWith({ runId: 42 });
    });

    test("returns 400 on parameter validation failure", async () => {
      process.env.DATABRICKS_JOB_ETL = "123";

      const plugin = new JobsPlugin({
        jobs: {
          etl: {
            taskType: "notebook",
            params: z.object({ key: z.string() }),
          },
        },
      });
      const routeSpy = vi.spyOn(plugin as any, "route");

      const mockRouter = { get: vi.fn(), post: vi.fn() };
      plugin.injectRoutes(mockRouter as any);

      const runRoute = routeSpy.mock.calls.find(
        (call) => (call[1] as any).name === "run",
      );
      const handler = (runRoute?.[1] as any).handler;

      const mockReq = {
        params: { jobKey: "etl" },
        body: { params: { key: 42 } },
        query: {},
        header: vi.fn().mockReturnValue("test-token"),
      } as any;

      const mockRes = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      } as any;

      await handler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          plugin: "jobs",
        }),
      );
    });
  });

  describe("GET /:jobKey/runs handler", () => {
    test("returns runs with default pagination", async () => {
      process.env.DATABRICKS_JOB_ETL = "123";

      const mockRuns = [
        { run_id: 1, state: { life_cycle_state: "TERMINATED" } },
        { run_id: 2, state: { life_cycle_state: "RUNNING" } },
      ];
      mockClient.jobs.listRuns.mockReturnValue(
        (async function* () {
          for (const run of mockRuns) yield run;
        })(),
      );

      const plugin = new JobsPlugin({});
      const routeSpy = vi.spyOn(plugin as any, "route");

      const mockRouter = { get: vi.fn(), post: vi.fn() };
      plugin.injectRoutes(mockRouter as any);

      const runsRoute = routeSpy.mock.calls.find(
        (call) => (call[1] as any).name === "runs",
      );
      const handler = (runsRoute?.[1] as any).handler;

      const mockReq = {
        params: { jobKey: "etl" },
        query: {},
        header: vi.fn().mockReturnValue("test-token"),
      } as any;

      const mockRes = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      } as any;

      await handler(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalledWith({
        runs: mockRuns,
      });
    });

    test("passes limit query param to listRuns", async () => {
      process.env.DATABRICKS_JOB_ETL = "123";

      mockClient.jobs.listRuns.mockReturnValue((async function* () {})());

      const plugin = new JobsPlugin({});
      const routeSpy = vi.spyOn(plugin as any, "route");

      const mockRouter = { get: vi.fn(), post: vi.fn() };
      plugin.injectRoutes(mockRouter as any);

      const runsRoute = routeSpy.mock.calls.find(
        (call) => (call[1] as any).name === "runs",
      );
      const handler = (runsRoute?.[1] as any).handler;

      const mockReq = {
        params: { jobKey: "etl" },
        query: { limit: "5" },
        header: vi.fn().mockReturnValue("test-token"),
      } as any;

      const mockRes = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      } as any;

      await handler(mockReq, mockRes);

      // Verify the connector was called with limit 5
      expect(mockClient.jobs.listRuns).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 5 }),
        expect.anything(),
      );
    });
  });

  describe("GET /:jobKey/runs/:runId handler", () => {
    test("returns run detail", async () => {
      process.env.DATABRICKS_JOB_ETL = "123";

      const mockRun = {
        run_id: 42,
        state: { life_cycle_state: "TERMINATED" },
      };
      mockClient.jobs.getRun.mockResolvedValue(mockRun);

      const plugin = new JobsPlugin({});
      const routeSpy = vi.spyOn(plugin as any, "route");

      const mockRouter = { get: vi.fn(), post: vi.fn() };
      plugin.injectRoutes(mockRouter as any);

      const detailRoute = routeSpy.mock.calls.find(
        (call) => (call[1] as any).name === "run-detail",
      );
      const handler = (detailRoute?.[1] as any).handler;

      const mockReq = {
        params: { jobKey: "etl", runId: "42" },
        query: {},
        header: vi.fn().mockReturnValue("test-token"),
      } as any;

      const mockRes = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      } as any;

      await handler(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalledWith(mockRun);
    });

    test("returns 400 for invalid runId", async () => {
      process.env.DATABRICKS_JOB_ETL = "123";

      const plugin = new JobsPlugin({});
      const routeSpy = vi.spyOn(plugin as any, "route");

      const mockRouter = { get: vi.fn(), post: vi.fn() };
      plugin.injectRoutes(mockRouter as any);

      const detailRoute = routeSpy.mock.calls.find(
        (call) => (call[1] as any).name === "run-detail",
      );
      const handler = (detailRoute?.[1] as any).handler;

      const mockReq = {
        params: { jobKey: "etl", runId: "not-a-number" },
        query: {},
        header: vi.fn().mockReturnValue("test-token"),
      } as any;

      const mockRes = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      } as any;

      await handler(mockReq, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: "Invalid runId",
        plugin: "jobs",
      });
    });
  });

  describe("GET /:jobKey/status handler", () => {
    test("returns latest run status", async () => {
      process.env.DATABRICKS_JOB_ETL = "123";

      const mockRun = {
        run_id: 42,
        state: { life_cycle_state: "TERMINATED" },
      };
      mockClient.jobs.listRuns.mockReturnValue(
        (async function* () {
          yield mockRun;
        })(),
      );

      const plugin = new JobsPlugin({});
      const routeSpy = vi.spyOn(plugin as any, "route");

      const mockRouter = { get: vi.fn(), post: vi.fn() };
      plugin.injectRoutes(mockRouter as any);

      const statusRoute = routeSpy.mock.calls.find(
        (call) => (call[1] as any).name === "status",
      );
      const handler = (statusRoute?.[1] as any).handler;

      const mockReq = {
        params: { jobKey: "etl" },
        query: {},
        header: vi.fn().mockReturnValue("test-token"),
      } as any;

      const mockRes = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      } as any;

      await handler(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalledWith({
        status: "TERMINATED",
        run: mockRun,
      });
    });

    test("returns null status when no runs exist", async () => {
      process.env.DATABRICKS_JOB_ETL = "123";

      mockClient.jobs.listRuns.mockReturnValue((async function* () {})());

      const plugin = new JobsPlugin({});
      const routeSpy = vi.spyOn(plugin as any, "route");

      const mockRouter = { get: vi.fn(), post: vi.fn() };
      plugin.injectRoutes(mockRouter as any);

      const statusRoute = routeSpy.mock.calls.find(
        (call) => (call[1] as any).name === "status",
      );
      const handler = (statusRoute?.[1] as any).handler;

      const mockReq = {
        params: { jobKey: "etl" },
        query: {},
        header: vi.fn().mockReturnValue("test-token"),
      } as any;

      const mockRes = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      } as any;

      await handler(mockReq, mockRes);

      expect(mockRes.json).toHaveBeenCalledWith({
        status: null,
        run: null,
      });
    });
  });

  describe("OBO header forwarding", () => {
    test("routes call this.asUser(req) for user context", async () => {
      process.env.DATABRICKS_JOB_ETL = "123";

      mockClient.jobs.listRuns.mockReturnValue((async function* () {})());

      const plugin = new JobsPlugin({});
      const asUserSpy = vi.spyOn(plugin, "asUser");
      const routeSpy = vi.spyOn(plugin as any, "route");

      const mockRouter = { get: vi.fn(), post: vi.fn() };
      plugin.injectRoutes(mockRouter as any);

      const runsRoute = routeSpy.mock.calls.find(
        (call) => (call[1] as any).name === "runs",
      );
      const handler = (runsRoute?.[1] as any).handler;

      const mockReq = {
        params: { jobKey: "etl" },
        query: {},
        header: vi.fn().mockReturnValue("test-token"),
      } as any;

      const mockRes = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      } as any;

      await handler(mockReq, mockRes);

      expect(asUserSpy).toHaveBeenCalledWith(mockReq);
    });
  });
});
