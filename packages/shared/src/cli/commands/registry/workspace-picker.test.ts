import { describe, expect, it, vi } from "vitest";
import {
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
  // The client factory param is typed WorkspaceClient; we can't import that
  // type here (SDK import is restricted to appkit's wrapper), so the fake is
  // built as a plain object and passed through the factory's inferred type.
  type ClientFactory = Parameters<typeof listWorkspaceResources>[2];
  type FakeClient = ReturnType<NonNullable<ClientFactory>>;
  /** Builds a fake client whose services yield the given items. */
  function fakeClient(services: Record<string, unknown>): FakeClient {
    return services as unknown as FakeClient;
  }

  /** An async-iterable service.list() that yields the provided items. */
  function asyncList(items: unknown[]) {
    return () =>
      (async function* () {
        for (const i of items) yield i;
      })();
  }

  it("returns choices from a successful warehouse list (SDK)", async () => {
    const factory = () =>
      fakeClient({
        warehouses: { list: asyncList([{ id: "w1", name: "One" }]) },
      });
    const res = await listWorkspaceResources(
      "sql_warehouse",
      undefined,
      factory,
    );
    expect(res).toEqual([{ value: "w1", label: "One (w1)" }]);
  });

  it("maps job_id + settings.name for jobs", async () => {
    const factory = () =>
      fakeClient({
        jobs: { list: asyncList([{ job_id: 42, settings: { name: "ETL" } }]) },
      });
    const res = await listWorkspaceResources("job", undefined, factory);
    expect(res).toEqual([{ value: "42", label: "ETL (42)" }]);
  });

  it("adapts genie listSpaces (Promise-wrapped .spaces)", async () => {
    const factory = () =>
      fakeClient({
        genie: {
          listSpaces: async () => ({
            spaces: [{ space_id: "s1", title: "Sales" }],
          }),
        },
      });
    const res = await listWorkspaceResources("genie_space", undefined, factory);
    expect(res).toEqual([{ value: "s1", label: "Sales (s1)" }]);
  });

  it("passes the profile to the client factory", async () => {
    const factory = vi.fn(() =>
      fakeClient({ warehouses: { list: asyncList([]) } }),
    );
    await listWorkspaceResources("sql_warehouse", "dogfood", factory);
    expect(factory).toHaveBeenCalledWith("dogfood");
  });

  it("returns [] for an unknown type", async () => {
    const factory = () => fakeClient({});
    expect(
      await listWorkspaceResources("nonsense", undefined, factory),
    ).toEqual([]);
  });

  it("returns [] when the SDK call throws (auth/network error)", async () => {
    const factory = () =>
      fakeClient({
        warehouses: {
          list: () => {
            throw new Error("auth failed");
          },
        },
      });
    expect(
      await listWorkspaceResources("sql_warehouse", undefined, factory),
    ).toEqual([]);
  });

  it("returns [] when the client factory throws", async () => {
    const factory = () => {
      throw new Error("no config");
    };
    expect(
      await listWorkspaceResources("sql_warehouse", undefined, factory),
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
