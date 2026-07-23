import { afterEach, describe, expect, it, vi } from "vitest";
import { exitCodeFor, printReport, printReportJson } from "./report";
import type { DoctorReport, ResourceCheckResult } from "./types";

function report(overrides: Partial<DoctorReport> = {}): DoctorReport {
  return {
    auth: { status: "ok" },
    resources: [],
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

  it("summary shows only non-zero categories", () => {
    const lines = capture(() =>
      printReport(
        report({ summary: { ok: 3, warn: 0, error: 0, skipped: 0 } }),
      ),
    );
    expect(lines.some((l) => l === "3 ok")).toBe(true);
    expect(lines.some((l) => /warning|error|skipped/.test(l))).toBe(false);
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
    expect(lines.some((l) => /Fix authentication first/.test(l))).toBe(true);
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
});

describe("printReportJson", () => {
  it("emits the full report as parseable JSON", () => {
    const r = report({ summary: { ok: 1, warn: 0, error: 0, skipped: 0 } });
    const lines = capture(() => printReportJson(r));
    expect(JSON.parse(lines.join("\n"))).toEqual(r);
  });
});
