import { describe, expect, it, vi } from "vitest";
import {
  type CliRunner,
  isFlatListable,
  isParentContext,
  listParentContextStep,
  listWorkspaceResources,
  parentContextDepth,
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

describe("isParentContext / parentContextDepth", () => {
  it("identifies the four parent-context types and their depth", () => {
    expect(isParentContext("volume")).toBe(true);
    expect(isParentContext("uc_function")).toBe(true);
    expect(isParentContext("secret")).toBe(true);
    expect(isParentContext("vector_search_index")).toBe(true);
    // flat types are not parent-context
    expect(isParentContext("sql_warehouse")).toBe(false);

    expect(parentContextDepth("volume")).toBe(3); // catalog → schema → volume
    expect(parentContextDepth("secret")).toBe(2); // scope → key
    expect(parentContextDepth("vector_search_index")).toBe(2);
    expect(parentContextDepth("sql_warehouse")).toBe(0);
  });
});

describe("listParentContextStep", () => {
  it("lists catalogs at step 0 for volume", () => {
    const run = vi.fn(() => ({
      status: 0,
      stdout: JSON.stringify([{ name: "main" }]),
    }));
    const step = listParentContextStep("volume", 0, [], "dogfood", run);
    expect(step?.key).toBe("catalog");
    expect(step?.choices).toEqual([{ value: "main", label: "main (main)" }]);
    expect(run).toHaveBeenCalledWith([
      "catalogs",
      "list",
      "-o",
      "json",
      "-p",
      "dogfood",
    ]);
  });

  it("passes the picked catalog+schema as positional args at step 2", () => {
    const run = vi.fn(() => ({
      status: 0,
      stdout: JSON.stringify([
        { full_name: "main.sales.events", name: "events" },
      ]),
    }));
    const step = listParentContextStep(
      "volume",
      2,
      ["main", "sales"],
      undefined,
      run,
    );
    expect(step?.key).toBe("volume");
    // positional args, not flags
    expect(run).toHaveBeenCalledWith([
      "volumes",
      "list",
      "main",
      "sales",
      "-o",
      "json",
    ]);
    expect(step?.choices).toEqual([
      { value: "main.sales.events", label: "events (main.sales.events)" },
    ]);
  });

  it("drills scope → key for secret", () => {
    const run = vi.fn(() => ({
      status: 0,
      stdout: JSON.stringify([{ key: "api-token" }]),
    }));
    const step = listParentContextStep(
      "secret",
      1,
      ["my-scope"],
      undefined,
      run,
    );
    expect(step?.key).toBe("key");
    expect(run).toHaveBeenCalledWith([
      "secrets",
      "list-secrets",
      "my-scope",
      "-o",
      "json",
    ]);
    expect(step?.choices).toEqual([
      { value: "api-token", label: "api-token (api-token)" },
    ]);
  });

  it("returns null past the end of the chain", () => {
    const run = vi.fn(() => ({ status: 0, stdout: "[]" }));
    expect(listParentContextStep("secret", 5, [], undefined, run)).toBeNull();
  });

  it("returns empty choices (not null) when a level lists nothing", () => {
    const run = vi.fn(() => ({ status: 0, stdout: "[]" }));
    const step = listParentContextStep("volume", 0, [], undefined, run);
    expect(step?.choices).toEqual([]);
  });
});
