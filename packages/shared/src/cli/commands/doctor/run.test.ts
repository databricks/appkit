import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runDoctor } from "./run";

/**
 * Tests for the doctor orchestrator. The auth layer reaches the Databricks SDK,
 * so these mock the bridge to keep the orchestration assertions deterministic
 * and offline.
 */
vi.mock("./databricks-client", () => ({
  SdkNotInstalledError: class SdkNotInstalledError extends Error {},
  // Default: a client whose currentUser.me() succeeds.
  getServiceClient: vi.fn(async () => ({
    client: { currentUser: { me: async () => ({ userName: "app-sp" }) } },
  })),
}));

// Real probes by default; individual tests override to simulate a hung probe.
vi.mock("./checks-existence", async (importActual) => ({
  ...(await importActual<typeof import("./checks-existence")>()),
}));

describe("runDoctor", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports ok auth by default", async () => {
    const report = await runDoctor({});
    expect(report.auth.status).toBe("ok");
    expect(report.auth.code).toBe("AUTH_OK");
  });

  it("counts the auth check in the summary (no resources ⇒ ok auth = 1 ok)", async () => {
    const spy = vi.spyOn(process, "cwd").mockReturnValue("/nonexistent-doctor");
    const report = await runDoctor({});
    expect(report.resources).toEqual([]);
    // Auth ok and nothing else *checked*; the two warnings are the setup notices
    // saying why (no .env, no manifest), which is the point of that directory.
    expect(report.summary.ok).toBe(1);
    expect(report.summary.error).toBe(0);
    expect(report.summary.skipped).toBe(0);
    expect(report.exitCode).toBe(0);
    spy.mockRestore();
  });

  it("warns instead of reporting a silent all-clear when run outside the app root", async () => {
    // The trap: a missing manifest yields zero targets, so `cd server &&
    // appkit doctor` used to print a bare green tick and exit 0 having checked
    // nothing at all.
    const spy = vi.spyOn(process, "cwd").mockReturnValue("/nonexistent-doctor");
    const report = await runDoctor({});

    // Only the manifest notice: without an app root, a missing .env is noise on
    // top of the one cause that matters (wrong directory).
    expect(report.setup.map((f) => f.code)).toEqual(["NO_RESOURCES_CHECKED"]);
    expect(report.setup[0].status).toBe("warn");
    // Advisory only — a shell-exported env is legitimate, so it can't fail CI.
    expect(report.exitCode).toBe(0);
    spy.mockRestore();
  });

  it("warns about a missing .env only once a manifest proves this is an app root", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-setup-"));
    const spy = vi.spyOn(process, "cwd").mockReturnValue(dir);
    try {
      fs.writeFileSync(path.join(dir, "appkit.plugins.json"), "{}");
      const report = await runDoctor({});
      expect(report.setup.map((f) => f.code)).toEqual(["ENV_FILE_MISSING"]);

      // With both present there's nothing to say.
      fs.writeFileSync(path.join(dir, ".env"), "FOO=bar\n");
      const clean = await runDoctor({});
      expect(clean.setup).toEqual([]);
    } finally {
      spy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("doesn't warn about a missing .env when --env-file was passed", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-envfile-"));
    const spy = vi.spyOn(process, "cwd").mockReturnValue(dir);
    try {
      fs.writeFileSync(path.join(dir, "appkit.plugins.json"), "{}");
      const report = await runDoctor({ envFile: "/tmp/whatever.env" });
      expect(report.setup).toEqual([]);
    } finally {
      spy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("doesn't error on a bundle-managed resource whose env var is unset locally", async () => {
    // The value comes from ${resources.*} at deploy time, so an unset var is the
    // normal pre-deploy state. This used to config-error and return before the
    // bundle-managed branch, failing CI for a correct app while the report
    // collapsed the row to "will be created on deploy" and hid the cause.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-bm-"));
    const spy = vi.spyOn(process, "cwd").mockReturnValue(dir);
    try {
      fs.writeFileSync(
        path.join(dir, "appkit.plugins.json"),
        JSON.stringify({
          plugins: {
            analytics: {
              requiredByTemplate: true,
              resources: {
                required: [
                  {
                    type: "sql_warehouse",
                    alias: "SQL Warehouse",
                    resourceKey: "sql-warehouse",
                    permission: "CAN_USE",
                    fields: {
                      id: { env: "DOCTOR_BM_WAREHOUSE", origin: "user" },
                    },
                  },
                ],
              },
            },
          },
        }),
      );
      fs.writeFileSync(
        path.join(dir, "databricks.yml"),
        `bundle:
  name: bm
resources:
  sql_warehouses:
    wh:
      name: created-by-bundle
  apps:
    app:
      name: bm
      resources:
        - name: sql-warehouse
          sql_warehouse:
            id: \${resources.sql_warehouses.wh.id}
            permission: CAN_USE
`,
      );
      fs.writeFileSync(
        path.join(dir, "app.yaml"),
        "env:\n  - name: DOCTOR_BM_WAREHOUSE\n    valueFrom: sql-warehouse\n",
      );
      fs.writeFileSync(path.join(dir, ".env"), "");
      delete process.env.DOCTOR_BM_WAREHOUSE;

      const report = await runDoctor({});

      expect(report.resources).toHaveLength(1);
      const [resource] = report.resources;
      expect(resource.status).toBe("skipped");
      // A --json consumer (or an agent) should see the deploy-created fact, and
      // no config error at all.
      expect(resource.layers.map((l) => l.code)).toEqual(["BUNDLE_MANAGED"]);
      expect(resource.layers.some((l) => l.status === "error")).toBe(false);
      expect(report.summary.error).toBe(0);
      expect(report.exitCode).toBe(0);
    } finally {
      spy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("folds an auth failure into summary.error and exitCode (the --json gap)", async () => {
    const { getServiceClient } = await import("./databricks-client");
    vi.mocked(getServiceClient).mockRejectedValueOnce(new Error("no creds"));
    // No manifest ⇒ no resources; only the failed auth contributes.
    const spy = vi.spyOn(process, "cwd").mockReturnValue("/nonexistent-doctor");

    const report = await runDoctor({});

    expect(report.auth.status).toBe("error");
    // The bug this guards: a --json consumer reading summary.error must see 1,
    // not 0, and exitCode must be non-zero.
    expect(report.summary.error).toBe(1);
    expect(report.exitCode).toBe(1);
    spy.mockRestore();
  });

  it("still resolves and offline-checks resources when auth fails", async () => {
    const { getServiceClient } = await import("./databricks-client");
    vi.mocked(getServiceClient).mockRejectedValueOnce(new Error("no creds"));

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-run-"));
    fs.writeFileSync(
      path.join(dir, "appkit.plugins.json"),
      JSON.stringify({
        version: "2.0",
        plugins: {
          analytics: {
            requiredByTemplate: true,
            resources: {
              required: [
                {
                  type: "sql_warehouse",
                  resourceKey: "sql-warehouse",
                  alias: "SQL Warehouse",
                  permission: "CAN_USE",
                  fields: { id: { env: "DOCTOR_RUN_MISSING_ENV" } },
                },
              ],
              optional: [],
            },
          },
        },
      }),
    );
    const spy = vi.spyOn(process, "cwd").mockReturnValue(dir);
    delete process.env.DOCTOR_RUN_MISSING_ENV;

    const report = await runDoctor({});

    expect(report.auth.status).toBe("error");
    // Resource was still resolved and offline-checked despite auth failure.
    expect(report.resources).toHaveLength(1);
    expect(report.resources[0].status).toBe("error");
    const configLayer = report.resources[0].layers.find(
      (l) => l.layer === "config",
    );
    expect(configLayer?.status).toBe("error");

    spy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("bounds a hung probe with a timeout instead of hanging forever", async () => {
    vi.useFakeTimers();
    const existence = await import("./checks-existence");
    // A probe that never settles — the reachable-but-unresponsive endpoint case.
    vi.spyOn(existence, "runExistenceProbe").mockReturnValue(
      new Promise(() => {}),
    );

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-hang-"));
    fs.writeFileSync(
      path.join(dir, "appkit.plugins.json"),
      JSON.stringify({
        version: "2.0",
        plugins: {
          analytics: {
            requiredByTemplate: true,
            resources: {
              required: [
                {
                  type: "sql_warehouse",
                  resourceKey: "sql-warehouse",
                  alias: "SQL Warehouse",
                  permission: "CAN_USE",
                  fields: { id: { env: "DOCTOR_HANG_ENV" } },
                },
              ],
              optional: [],
            },
          },
        },
      }),
    );
    const spy = vi.spyOn(process, "cwd").mockReturnValue(dir);
    process.env.DOCTOR_HANG_ENV = "wh-123"; // config passes → reach existence

    const runPromise = runDoctor({});
    // Fire the deadline; without the timeout this promise would never resolve.
    await vi.advanceTimersByTimeAsync(10_000);
    const report = await runPromise;

    const existenceLayer = report.resources[0].layers.find(
      (l) => l.layer === "existence",
    );
    expect(existenceLayer?.status).toBe("error");
    expect(existenceLayer?.code).toBe("PROBE_TIMEOUT");

    delete process.env.DOCTOR_HANG_ENV;
    spy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("maps an unexpected throw to a PROBE_EXCEPTION row (never crashes the report)", async () => {
    const existence = await import("./checks-existence");
    // A synchronous throw — before withTimeout wraps it — so it bypasses the
    // probe's own .catch and would otherwise reject Promise.all.
    vi.spyOn(existence, "runExistenceProbe").mockImplementation(() => {
      throw new Error("kaboom");
    });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doctor-throw-"));
    fs.writeFileSync(
      path.join(dir, "appkit.plugins.json"),
      JSON.stringify({
        version: "2.0",
        plugins: {
          analytics: {
            requiredByTemplate: true,
            resources: {
              required: [
                {
                  type: "sql_warehouse",
                  resourceKey: "sql-warehouse",
                  alias: "SQL Warehouse",
                  permission: "CAN_USE",
                  fields: { id: { env: "DOCTOR_THROW_ENV" } },
                },
              ],
              optional: [],
            },
          },
        },
      }),
    );
    const spy = vi.spyOn(process, "cwd").mockReturnValue(dir);
    process.env.DOCTOR_THROW_ENV = "wh-123"; // config passes → reach existence

    // Must resolve (not reject) — the whole report survives one bad resource.
    const report = await runDoctor({});
    expect(report.resources).toHaveLength(1);
    expect(report.resources[0].status).toBe("error");
    const layer = report.resources[0].layers.find(
      (l) => l.code === "PROBE_EXCEPTION",
    );
    expect(layer?.detail).toContain("kaboom");

    delete process.env.DOCTOR_THROW_ENV;
    spy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
