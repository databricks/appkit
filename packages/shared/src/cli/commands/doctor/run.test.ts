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
    // Auth ok, no resources/wiring → summary reflects the auth check alone.
    expect(report.summary).toEqual({ ok: 1, warn: 0, error: 0, skipped: 0 });
    expect(report.exitCode).toBe(0);
    spy.mockRestore();
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
});
