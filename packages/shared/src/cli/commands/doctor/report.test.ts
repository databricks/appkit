import { afterEach, describe, expect, it, vi } from "vitest";

import { printReport, printReportJson } from "./report";
import type { DoctorReport, ResourceCheckResult } from "./types";

function report(overrides: Partial<DoctorReport> = {}): DoctorReport {
  return {
    auth: { status: "ok" },
    resources: [],
    wiring: [],
    setup: [],
    summary: { ok: 0, warn: 0, error: 0, skipped: 0 },
    exitCode: 0,
    ...overrides,
  };
}

// oxlint-disable-next-line no-control-regex -- matches ANSI SGR escape sequences (ESC control char is intentional)
const ANSI = /\x1b\[[0-9;]*m/g;

/** Runs `fn` with console.log captured; returns the printed lines with any ANSI
 * colour codes stripped, so assertions are colour-agnostic (picocolors emits
 * codes when CI forces colour / a TTY is present, and none otherwise). */
function capture(fn: () => void): string[] {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
    lines.push(String(msg).replace(ANSI, ""));
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
      setup: [],
      summary: { ok: 1, warn: 1, error: 1, skipped: 1 },
      exitCode: 1,
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

  it("shows the host and profile under a failed auth row", () => {
    const lines = capture(() =>
      printReport(
        report({
          auth: {
            status: "error",
            detail: "authentication failed",
            host: "https://foo.cloud.databricks.com",
            profile: "prod",
          },
        }),
      ),
    );
    const host = lines.find((l) => l.includes("host:"));
    expect(host).toContain("https://foo.cloud.databricks.com");
    // The host is the workspace actually contacted, so it leads the profile.
    expect(lines.indexOf(host as string)).toBeLessThan(
      lines.findIndex((l) => l.includes("profile:")),
    );
  });

  it("stays quiet about the host when auth succeeded", () => {
    const lines = capture(() =>
      printReport(
        report({
          auth: {
            status: "ok",
            detail: "authenticated as u",
            host: "https://foo.cloud.databricks.com",
          },
        }),
      ),
    );
    expect(lines.some((l) => l.includes("host:"))).toBe(false);
  });

  it("omits the host line when no host could be resolved", () => {
    const lines = capture(() =>
      printReport(
        report({
          auth: { status: "error", detail: "authentication failed" },
        }),
      ),
    );
    expect(lines.some((l) => l.includes("host:"))).toBe(false);
  });

  it("never hides a finding on a bundle-managed row", () => {
    // The row used to drop its layers entirely, so an error counted in the
    // summary had no visible cause anywhere in the output.
    const managed = res("error", "sql_warehouse");
    managed.target.origin = "bundle-managed";
    managed.target.alias = "Managed WH";
    managed.layers = [
      { layer: "existence", status: "skipped", code: "BUNDLE_MANAGED" },
      {
        layer: "config",
        status: "error",
        code: "SOMETHING_REAL",
        detail: "a genuine problem worth seeing",
      },
    ];
    const lines = capture(() =>
      printReport(
        report({
          resources: [managed],
          summary: { ok: 0, warn: 0, error: 1, skipped: 0 },
          exitCode: 1,
        }),
      ),
    );
    expect(lines.some((l) => l.includes("will be created on deploy"))).toBe(
      true,
    );
    expect(
      lines.some((l) => l.includes("a genuine problem worth seeing")),
    ).toBe(true);
  });

  it("keeps a clean bundle-managed row to a single line", () => {
    const managed = res("skipped", "job");
    managed.target.origin = "bundle-managed";
    managed.target.alias = "Managed Job";
    managed.layers = [
      {
        layer: "existence",
        status: "skipped",
        code: "BUNDLE_MANAGED",
        detail: "created by this bundle on deploy — not probed",
      },
    ];
    const lines = capture(() => printReport(report({ resources: [managed] })));
    // The BUNDLE_MANAGED detail would only restate the row's own label.
    expect(lines.some((l) => l.includes("not probed"))).toBe(false);
  });

  it("renders setup notices in the flat list", () => {
    const lines = capture(() =>
      printReport(
        report({
          setup: [
            {
              status: "warn",
              code: "ENV_FILE_MISSING",
              label: ".env",
              detail: "no .env found in /some/dir",
              hint: "Run doctor from the app root.",
            },
          ],
          summary: { ok: 1, warn: 1, error: 0, skipped: 0 },
        }),
      ),
    );
    expect(lines.some((l) => l.includes(".env"))).toBe(true);
    expect(lines.some((l) => l.includes("no .env found in /some/dir"))).toBe(
      true,
    );
    expect(lines.some((l) => l.includes("Run doctor from the app root."))).toBe(
      true,
    );
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

  it("renders the authoritative summary verbatim (no re-folding)", () => {
    // summary is built in runDoctor and already includes auth + wiring; the
    // renderer must print it as-is, not recompute.
    const lines = capture(() =>
      printReport(
        report({
          auth: { status: "error", detail: "bad creds" },
          summary: { ok: 0, warn: 0, error: 1, skipped: 0 },
          exitCode: 1,
        }),
      ),
    );
    expect(lines.some((l) => l.startsWith("1 error"))).toBe(true);
  });
});

describe("printReportJson", () => {
  it("emits the full report as parseable JSON", () => {
    const r = report({ summary: { ok: 1, warn: 0, error: 0, skipped: 0 } });
    const lines = capture(() => printReportJson(r));
    expect(JSON.parse(lines.join("\n"))).toEqual(r);
  });

  it("strips the raw SDK error by default (matches the --detail gate)", () => {
    const r = report({
      auth: {
        status: "error",
        detail: "authentication failed",
        raw: "default auth: cannot get access token: <sensitive blob>",
      },
    });
    const parsed = capture(() => printReportJson(r));
    const out = JSON.parse(parsed.join("\n")) as DoctorReport;
    expect(out.auth.raw).toBeUndefined();
    expect(parsed.join("\n")).not.toContain("<sensitive blob>");
  });

  it("includes raw when detail=true (opt-in)", () => {
    const r = report({
      auth: {
        status: "error",
        detail: "authentication failed",
        raw: "default auth: cannot get access token: <sensitive blob>",
      },
    });
    const parsed = capture(() => printReportJson(r, true));
    const out = JSON.parse(parsed.join("\n")) as DoctorReport;
    expect(out.auth.raw).toContain("<sensitive blob>");
  });
});
