import { afterEach, describe, expect, it, vi } from "vitest";
import { exitCodeFor, printReport, printReportJson } from "./report";
import type { DoctorReport, ResourceCheckResult } from "./types";

function report(overrides: Partial<DoctorReport> = {}): DoctorReport {
  return {
    auth: { status: "ok" },
    resources: [],
    wiring: [],
    summary: { ok: 0, warn: 0, error: 0, skipped: 0 },
    ...overrides,
  };
}

/** Runs `fn` with console.log captured; returns the printed lines. */
function capture(fn: () => void): string[] {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
    lines.push(String(msg));
  });
  try {
    fn();
    return lines;
  } finally {
    spy.mockRestore();
  }
}

function res(
  status: ResourceCheckResult["status"],
  type: string,
): ResourceCheckResult {
  return {
    target: {
      type,
      resourceKey: type,
      alias: type,
      plugin: "p",
      requiredPermission: "X",
      required: true,
      envVars: [],
      fieldValues: {},
    },
    status,
    layers: [],
  };
}

describe("printReport ordering", () => {
  afterEach(() => vi.restoreAllMocks());

  it("prints resources most-severe first (error, warn, skipped, ok)", () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
      lines.push(String(msg));
    });

    // Deliberately supplied in non-severity order.
    const report: DoctorReport = {
      auth: { status: "ok" },
      resources: [
        res("warn", "warned"),
        res("ok", "okay"),
        res("error", "errored"),
        res("skipped", "skip"),
      ],
      wiring: [],
      summary: { ok: 1, warn: 1, error: 1, skipped: 1 },
    };

    printReport(report);

    const order = ["errored", "warned", "skip", "okay"].map((t) =>
      lines.findIndex((l) => l.includes(t)),
    );
    // Every row was printed and appears in strictly increasing (severity) order.
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("hides raw error by default, shows it with detail=true", () => {
    const withRaw = report({
      auth: {
        status: "error",
        detail: "authentication failed",
        hint: "Run `databricks auth login`.",
        raw: "default auth: databricks-cli: cannot get access token: <long blob>",
      },
      summary: { ok: 0, warn: 0, error: 0, skipped: 0 },
    });

    // Default: headline + hint, no raw blob, plus a nudge toward --detail.
    const plain = capture(() => printReport(withRaw));
    expect(plain.some((l) => l.includes("authentication failed"))).toBe(true);
    expect(plain.some((l) => l.includes("Hint:"))).toBe(true);
    expect(plain.some((l) => l.includes("<long blob>"))).toBe(false);
    expect(plain.some((l) => /Run with --detail/.test(l))).toBe(true);

    // --detail: raw blob is surfaced under a "Details:" block; no nudge.
    const detailed = capture(() => printReport(withRaw, true));
    expect(detailed.some((l) => l.includes("Details:"))).toBe(true);
    expect(detailed.some((l) => l.includes("<long blob>"))).toBe(true);
    expect(detailed.some((l) => /Run with --detail/.test(l))).toBe(false);
  });

  it("summary shows only non-zero categories", () => {
    const lines = capture(() =>
      printReport(
        report({ summary: { ok: 3, warn: 0, error: 0, skipped: 0 } }),
      ),
    );
    expect(lines.some((l) => l === "3 ok")).toBe(true);
    expect(lines.some((l) => /warning|error|skipped/.test(l))).toBe(false);
  });

  it("renders bundle-managed resources and wiring findings in the flat list", () => {
    const external = res("ok", "sql_warehouse"); // origin undefined ⇒ runtime
    const managed = res("skipped", "job");
    managed.target.origin = "bundle-managed";
    managed.target.alias = "Report Job";
    managed.layers = [
      { layer: "existence", status: "skipped", code: "BUNDLE_MANAGED" },
    ];

    const lines = capture(() =>
      printReport(
        report({
          resources: [external, managed],
          wiring: [
            {
              status: "error",
              code: "VALUEFROM_UNBOUND",
              label: "SOME_ENV",
              detail: "app.yaml binds X to Y, no such binding",
            },
          ],
          summary: { ok: 1, warn: 0, error: 0, skipped: 1 },
        }),
      ),
    );
    const out = lines.join("\n");
    // No titled sub-sections: a single flat, severity-sorted checklist.
    expect(out).not.toContain("Runtime connectivity");
    expect(out).not.toContain("Deploy declaration");
    // A bundle-managed resource is shown as deploy-created, not probed.
    expect(out).toContain("will be created on deploy");
    expect(out).toContain("Report Job");
    // The wiring error sorts to the top (most severe), above the ok resource.
    const wiringIdx = lines.findIndex((l) => l.includes("no such binding"));
    const okIdx = lines.findIndex((l) => l.includes("sql_warehouse"));
    expect(wiringIdx).toBeGreaterThanOrEqual(0);
    expect(wiringIdx).toBeLessThan(okIdx);
  });

  it("folds an auth error into the summary error count", () => {
    const lines = capture(() =>
      printReport(
        report({
          auth: { status: "error", detail: "bad creds" },
          summary: { ok: 0, warn: 0, error: 0, skipped: 0 },
        }),
      ),
    );
    // Auth failure counts as an error even though no resource errored.
    expect(lines.some((l) => l.startsWith("1 error"))).toBe(true);
  });
});

describe("exitCodeFor", () => {
  it("is 0 when auth ok and no resource errors", () => {
    expect(
      exitCodeFor(
        report({ summary: { ok: 2, warn: 1, error: 0, skipped: 1 } }),
      ),
    ).toBe(0);
  });

  it("is 1 when auth failed", () => {
    expect(exitCodeFor(report({ auth: { status: "error" } }))).toBe(1);
  });

  it("is 1 when any resource errored", () => {
    expect(
      exitCodeFor(
        report({ summary: { ok: 0, warn: 0, error: 1, skipped: 0 } }),
      ),
    ).toBe(1);
  });

  it("is 1 when a wiring finding errored (gates pre-deploy)", () => {
    expect(
      exitCodeFor(
        report({
          summary: { ok: 0, warn: 0, error: 0, skipped: 0 },
          wiring: [
            {
              status: "error",
              code: "VALUEFROM_UNBOUND",
              label: "X",
              detail: "x",
            },
          ],
        }),
      ),
    ).toBe(1);
  });
});

describe("printReportJson", () => {
  it("emits the full report as parseable JSON", () => {
    const r = report({ summary: { ok: 1, warn: 0, error: 0, skipped: 0 } });
    const lines = capture(() => printReportJson(r));
    expect(JSON.parse(lines.join("\n"))).toEqual(r);
  });
});
