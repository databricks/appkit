import { describe, expect, it, vi } from "vitest";
import {
  composeResourceId,
  isFlatListable,
  isParentContext,
  listParentContextStep,
  listWorkspaceResources,
  MAX_PICKER_RESULTS,
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
    expect(res).toEqual({
      choices: [{ value: "w1", label: "One (w1)" }],
      truncated: false,
    });
  });

  it("maps job_id + settings.name for jobs", async () => {
    const factory = () =>
      fakeClient({
        jobs: { list: asyncList([{ job_id: 42, settings: { name: "ETL" } }]) },
      });
    const res = await listWorkspaceResources("job", undefined, factory);
    expect(res.choices).toEqual([{ value: "42", label: "ETL (42)" }]);
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
    expect(res.choices).toEqual([{ value: "s1", label: "Sales (s1)" }]);
  });

  // genie listSpaces is single-page; the adapter must follow next_page_token
  // so large workspaces aren't capped at one page.
  it("follows genie next_page_token across pages", async () => {
    const pages: Record<
      string,
      { spaces: unknown[]; next_page_token?: string }
    > = {
      "": { spaces: [{ space_id: "s1" }], next_page_token: "p2" },
      p2: { spaces: [{ space_id: "s2" }] },
    };
    const seen: (string | undefined)[] = [];
    const factory = () =>
      fakeClient({
        genie: {
          listSpaces: async (req: { page_token?: string }) => {
            seen.push(req.page_token);
            return pages[req.page_token ?? ""];
          },
        },
      });
    const res = await listWorkspaceResources("genie_space", undefined, factory);
    expect(res.choices.map((c) => c.value)).toEqual(["s1", "s2"]);
    expect(seen).toEqual([undefined, "p2"]);
  });

  it("stops genie pagination if the same token is echoed back", async () => {
    const factory = () =>
      fakeClient({
        genie: {
          listSpaces: async () => ({
            spaces: [{ space_id: "s1" }],
            next_page_token: "same",
          }),
        },
      });
    // Would loop forever if the repeated-token guard weren't present.
    const res = await listWorkspaceResources("genie_space", undefined, factory);
    expect(res.choices.length).toBeGreaterThan(0);
  });

  it("passes the profile to the client factory", async () => {
    const factory = vi.fn(() =>
      fakeClient({ warehouses: { list: asyncList([]) } }),
    );
    await listWorkspaceResources("sql_warehouse", "my-profile", factory);
    expect(factory).toHaveBeenCalledWith("my-profile");
  });

  it("caps results and reports truncation, stopping pagination early", async () => {
    // Yield far more than the cap; the iterator must be abandoned at the cap.
    let yielded = 0;
    const factory = () =>
      fakeClient({
        warehouses: {
          list: () =>
            (async function* () {
              for (let i = 0; i < 10_000; i++) {
                yielded++;
                yield { id: `w${i}`, name: `W${i}` };
              }
            })(),
        },
      });
    const res = await listWorkspaceResources(
      "sql_warehouse",
      undefined,
      factory,
    );
    expect(res.truncated).toBe(true);
    expect(res.choices).toHaveLength(MAX_PICKER_RESULTS);
    // Pagination stopped: we consumed only up to the cap, not all 10k.
    expect(yielded).toBe(MAX_PICKER_RESULTS);
  });

  it("returns empty listing for an unknown type", async () => {
    const factory = () => fakeClient({});
    expect(
      await listWorkspaceResources("nonsense", undefined, factory),
    ).toEqual({ choices: [], truncated: false });
  });

  it("returns empty listing when the SDK call throws (auth/network error)", async () => {
    const factory = () =>
      fakeClient({
        warehouses: {
          list: () => {
            throw new Error("auth failed");
          },
        },
      });
    expect(
      (await listWorkspaceResources("sql_warehouse", undefined, factory))
        .choices,
    ).toEqual([]);
  });

  it("reports the failure reason instead of a silent empty listing", async () => {
    const factory = () =>
      fakeClient({
        warehouses: {
          list: () => {
            throw new Error(
              "default auth: cannot configure default credentials",
            );
          },
        },
      });
    const res = await listWorkspaceResources(
      "sql_warehouse",
      undefined,
      factory,
    );
    expect(res.choices).toEqual([]);
    expect(res.error).toContain("cannot configure default credentials");
  });

  it("has no error field for a genuinely empty (unknown-type) listing", async () => {
    const factory = () => fakeClient({});
    const res = await listWorkspaceResources("nonsense", undefined, factory);
    expect(res.error).toBeUndefined();
  });

  it("returns empty listing when the client factory throws", async () => {
    const factory = () => {
      throw new Error("no config");
    };
    expect(
      (await listWorkspaceResources("sql_warehouse", undefined, factory))
        .choices,
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
    const step = listParentContextStep("volume", 0, [], "my-profile", run);
    expect(step?.key).toBe("catalog");
    expect(step?.choices).toEqual([{ value: "main", label: "main (main)" }]);
    expect(run).toHaveBeenCalledWith([
      "catalogs",
      "list",
      "-o",
      "json",
      "-p",
      "my-profile",
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

  // A prior pick starting with `-` would be parsed as a flag when passed as a
  // positional arg, so refuse it rather than shell out with it.
  it("refuses a `-`-prefixed parent pick without running the CLI", () => {
    const run = vi.fn(() => ({ status: 0, stdout: "[]" }));
    const step = listParentContextStep(
      "volume",
      1,
      ["--profile"],
      undefined,
      run,
    );
    expect(step?.choices).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("composeResourceId", () => {
  it("joins scope and key for a secret", () => {
    expect(composeResourceId("secret", ["my-scope", "api-token"])).toBe(
      "my-scope/api-token",
    );
  });

  it("returns the last (self-qualified) pick for other types", () => {
    expect(
      composeResourceId("volume", ["main", "sales", "main.sales.events"]),
    ).toBe("main.sales.events");
    expect(composeResourceId("vector_search_index", ["ep", "idx"])).toBe("idx");
  });
});
