import { describe, expect, it, vi } from "vitest";
import {
  type CliRunner,
  isFlatListable,
  listWorkspaceResources,
  toChoices,
} from "./workspace-picker";

describe("isFlatListable", () => {
  it("recognizes flat types and rejects parent-context/unknown ones", () => {
    expect(isFlatListable("sql_warehouse")).toBe(true);
    expect(isFlatListable("genie_space")).toBe(true);
    // parent-context types are handled elsewhere
    expect(isFlatListable("volume")).toBe(false);
    expect(isFlatListable("secret")).toBe(false);
    expect(isFlatListable("nonsense")).toBe(false);
  });
});

describe("toChoices", () => {
  it("reads id and label from a bare array", () => {
    const choices = toChoices(
      [{ id: "w1", name: "Warehouse One" }],
      "id",
      "name",
    );
    expect(choices).toEqual([{ value: "w1", label: "Warehouse One (w1)" }]);
  });

  it("unwraps a single wrapper key holding the array", () => {
    const choices = toChoices({ warehouses: [{ id: "w2" }] }, "id", "name");
    expect(choices).toEqual([{ value: "w2", label: "w2" }]);
  });

  it("skips items missing the id field", () => {
    const choices = toChoices([{ name: "no id" }, { id: "ok" }], "id", "name");
    expect(choices).toEqual([{ value: "ok", label: "ok" }]);
  });

  it("coerces non-string ids (e.g. numeric job_id)", () => {
    const choices = toChoices([{ job_id: 42, name: "ETL" }], "job_id", "name");
    expect(choices).toEqual([{ value: "42", label: "ETL (42)" }]);
  });
});

describe("listWorkspaceResources", () => {
  const runner = (stdout: string, status = 0): CliRunner =>
    vi.fn(() => ({ status, stdout }));

  it("returns choices from a successful list", () => {
    const res = listWorkspaceResources(
      "sql_warehouse",
      undefined,
      runner(JSON.stringify([{ id: "w1", name: "One" }])),
    );
    expect(res).toEqual([{ value: "w1", label: "One (w1)" }]);
  });

  it("passes -p profile through to the CLI", () => {
    const run = vi.fn(() => ({ status: 0, stdout: "[]" }));
    listWorkspaceResources("sql_warehouse", "dogfood", run);
    expect(run).toHaveBeenCalledWith([
      "warehouses",
      "list",
      "-o",
      "json",
      "-p",
      "dogfood",
    ]);
  });

  it("returns [] for an unknown type", () => {
    expect(listWorkspaceResources("nonsense", undefined, runner("[]"))).toEqual(
      [],
    );
  });

  it("returns [] on non-zero CLI exit (offline/auth error)", () => {
    expect(
      listWorkspaceResources("sql_warehouse", undefined, runner("", 1)),
    ).toEqual([]);
  });

  it("returns [] on non-JSON output", () => {
    expect(
      listWorkspaceResources("sql_warehouse", undefined, runner("not json")),
    ).toEqual([]);
  });

  it("returns [] when the runner throws (CLI missing)", () => {
    const throwing: CliRunner = () => {
      throw new Error("ENOENT");
    };
    expect(
      listWorkspaceResources("sql_warehouse", undefined, throwing),
    ).toEqual([]);
  });
});
