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

describe("runDoctor", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports ok auth by default", async () => {
    const report = await runDoctor({});
    expect(report.auth.status).toBe("ok");
    expect(report.auth.code).toBe("AUTH_OK");
  });

  it("resolves no resources when cwd has no manifest, with an empty summary", async () => {
    // Point cwd at a dir guaranteed to have no appkit.plugins.json.
    const spy = vi.spyOn(process, "cwd").mockReturnValue("/nonexistent-doctor");
    const report = await runDoctor({});
    expect(report.resources).toEqual([]);
    expect(report.summary).toEqual({ ok: 0, warn: 0, error: 0, skipped: 0 });
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
});
