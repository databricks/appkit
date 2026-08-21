import { describe, expect, it } from "vitest";

import type { BundleInfo } from "./bundle";
import { checkWiring } from "./checks-wiring";
import type { ResourceTarget } from "./types";

function info(overrides: Partial<BundleInfo> = {}): BundleInfo {
  return {
    bindings: new Map(),
    envToBinding: new Map(),
    declaredResources: new Set(),
    present: true,
    ...overrides,
  };
}

function target(overrides: Partial<ResourceTarget> = {}): ResourceTarget {
  return {
    type: "sql_warehouse",
    resourceKey: "sql-warehouse",
    alias: "SQL Warehouse",
    plugin: "analytics",
    requiredPermission: "CAN_USE",
    required: true,
    envVars: [],
    fieldValues: {},
    ...overrides,
  };
}

describe("checkWiring", () => {
  it("returns nothing when no bundle is present", () => {
    expect(checkWiring(info({ present: false }), [])).toEqual([]);
  });

  it("flags an app.yaml valueFrom that matches no binding", () => {
    const findings = checkWiring(
      info({ envToBinding: new Map([["DATABRICKS_WAREHOUSE_ID", "sql-wh"]]) }),
      [],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("VALUEFROM_UNBOUND");
    expect(findings[0].status).toBe("error");
  });

  it("flags a bundle-managed ref to an undeclared resource", () => {
    const findings = checkWiring(
      info({
        bindings: new Map([
          [
            "job",
            {
              name: "job",
              type: "job",
              origin: "bundle-managed",
              ref: { type: "jobs", key: "ghost" },
            },
          ],
        ]),
        declaredResources: new Set(), // jobs.ghost NOT declared
      }),
      [],
    );
    expect(findings.some((f) => f.code === "BUNDLE_REF_MISSING")).toBe(true);
  });

  it("passes a bundle-managed ref that resolves to a declared resource", () => {
    const findings = checkWiring(
      info({
        bindings: new Map([
          [
            "job",
            {
              name: "job",
              type: "job",
              origin: "bundle-managed",
              ref: { type: "jobs", key: "report" },
            },
          ],
        ]),
        declaredResources: new Set(["jobs.report"]),
      }),
      [],
    );
    expect(findings.some((f) => f.code === "BUNDLE_REF_MISSING")).toBe(false);
  });

  it("warns for an OPTIONAL plugin's env var that app.yaml doesn't provide", () => {
    const findings = checkWiring(
      info({
        // app.yaml provides one env, bindings exist for it.
        envToBinding: new Map([["DATABRICKS_WAREHOUSE_ID", "sql-warehouse"]]),
        bindings: new Map([
          [
            "sql-warehouse",
            {
              name: "sql-warehouse",
              type: "sql_warehouse",
              origin: "external",
            },
          ],
        ]),
      }),
      [
        target({
          required: false,
          envVars: ["DATABRICKS_WAREHOUSE_ID", "DATABRICKS_MISSING"],
        }),
      ],
    );
    const unwired = findings.find((f) => f.code === "ENV_UNWIRED");
    expect(unwired?.status).toBe("warn");
    expect(unwired?.label).toBe("DATABRICKS_MISSING");
  });

  it("errors for a REQUIRED plugin's unwired env var, gating the exit code", () => {
    // The "works locally, breaks on deploy" case: a required env is set via
    // local .env but has no app.yaml entry, so it's unset in the deployed
    // container — a guaranteed break, so it must be an error, not a warning.
    const findings = checkWiring(
      info({ present: true }), // empty bindings + empty envToBinding
      [
        target({
          required: true,
          alias: "SQL Warehouse",
          envVars: ["DATABRICKS_WAREHOUSE_ID"],
        }),
      ],
    );
    const unwired = findings.find((f) => f.code === "ENV_UNWIRED");
    expect(unwired?.status).toBe("error");
    expect(unwired?.label).toBe("DATABRICKS_WAREHOUSE_ID");
    // Names the concrete consequence — the var is absent from the deployed app's
    // environment — rather than the vaguer "unset in the deployed app".
    expect(unwired?.detail).toMatch(
      /won't be set in the environment of the deployed app/i,
    );
  });

  it("marks an optional resource's unwired var as optional in the detail", () => {
    const findings = checkWiring(info({ present: true }), [
      target({ required: false, envVars: ["DATABRICKS_MISSING"] }),
    ]);
    const unwired = findings.find((f) => f.code === "ENV_UNWIRED");
    expect(unwired?.status).toBe("warn");
    expect(unwired?.detail).toMatch(
      /won't be set in the environment of the deployed app \(optional\)/i,
    );
  });
});
