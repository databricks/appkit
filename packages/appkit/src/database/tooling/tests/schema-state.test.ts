import { describe, expect, test } from "vitest";

import { planStart, type SchemaState, type StartPlan } from "../schema-state";

const absent: SchemaState = { kind: "absent" };
const copy: SchemaState = { kind: "copy", owner: "app-sp" };
const interrupted: SchemaState = { kind: "interrupted-rebuild" };
const yours: SchemaState = { kind: "yours" };
const pub: SchemaState = { kind: "public", kept: ["table notes"] };

const only = (plan: Partial<StartPlan> & Pick<StartPlan, "kind">) => ({
  rebuild: false,
  tag: false,
  handOff: false,
  keepsCopy: false,
  confirm: false,
  ...plan,
});

describe("planStart", () => {
  test.each([
    [absent, "migrate"],
    [yours, "migrate"],
    [pub, "migrate"],
  ] as const)(
    "%j without a request migrates with schema.ts and introspects without",
    (state, kind) => {
      expect(planStart(state, undefined, true)).toEqual(only({ kind }));
      expect(planStart(state, undefined, false)).toEqual(
        only({ kind: "introspect" }),
      );
    },
  );

  test("a copy another role owns is tagged, handed off and rebuilt; introspect writes schema.ts first when there is none", () => {
    const rebuilt = { rebuild: true, tag: true, handOff: true };
    expect(planStart(copy, undefined, true)).toEqual(
      only({ kind: "clean", ...rebuilt }),
    );
    expect(planStart(copy, undefined, false)).toEqual(
      only({ kind: "introspect", ...rebuilt }),
    );
    expect(planStart(copy, "clean", true)).toEqual(
      only({ kind: "clean", ...rebuilt }),
    );
  });

  test("an interrupted rebuild is finished without another hand-off or tag", () => {
    expect(planStart(interrupted, undefined, true)).toEqual(
      only({ kind: "clean", rebuild: true }),
    );
    expect(planStart(interrupted, "clean", true)).toEqual(
      only({ kind: "clean", rebuild: true }),
    );
  });

  test("an interrupted rebuild without schema.ts cannot be finished by default: the message says how to continue", () => {
    expect(() => planStart(interrupted, undefined, false)).toThrow(
      "Restore schema.ts, then rerun `appkit db init`. `appkit db init --schema introspect` writes schema.ts from the branch and keeps the rows the fork copied.",
    );
  });

  test.each(["migrate", "introspect"] as const)(
    "--schema %s on a copy keeps its rows: the untouched copy is handed off, neither is tagged",
    (requested) => {
      expect(planStart(copy, requested, true)).toEqual(
        only({ kind: requested, handOff: true, keepsCopy: true }),
      );
      expect(planStart(interrupted, requested, true)).toEqual(
        only({ kind: requested, keepsCopy: true }),
      );
    },
  );

  test("on a branch this run forked, a schema you already owned is a copy too: tagged and rebuilt, with no hand-off and no question", () => {
    const rebuilt = { rebuild: true, tag: true };
    expect(planStart(yours, undefined, true, true)).toEqual(
      only({ kind: "clean", ...rebuilt }),
    );
    expect(planStart(yours, undefined, false, true)).toEqual(
      only({ kind: "introspect", ...rebuilt }),
    );
    expect(planStart(yours, "clean", true, true)).toEqual(
      only({ kind: "clean", ...rebuilt }),
    );
  });

  test.each(["migrate", "introspect"] as const)(
    "--schema %s on a schema you owned before the fork keeps its rows, with no hand-off",
    (requested) => {
      expect(planStart(yours, requested, true, true)).toEqual(
        only({ kind: requested, keepsCopy: true }),
      );
    },
  );

  test("the fork changes nothing where no schema exists, on public, or for a copy", () => {
    expect(planStart(absent, undefined, true, true)).toEqual(
      only({ kind: "migrate" }),
    );
    expect(planStart(pub, undefined, true, true)).toEqual(
      only({ kind: "migrate" }),
    );
    expect(planStart(copy, undefined, true, true)).toEqual(
      planStart(copy, undefined, true),
    );
    expect(planStart(interrupted, undefined, true, true)).toEqual(
      planStart(interrupted, undefined, true),
    );
  });

  test("an explicit clean asks first on your working branch and on public, not where nothing exists or on a copy", () => {
    expect(planStart(yours, "clean", true)).toEqual(
      only({ kind: "clean", rebuild: true, confirm: true }),
    );
    expect(planStart(pub, "clean", true)).toEqual(
      only({ kind: "clean", rebuild: true, confirm: true }),
    );
    expect(planStart(absent, "clean", true)).toEqual(
      only({ kind: "clean", rebuild: true }),
    );
    expect(planStart(copy, "clean", true).confirm).toBe(false);
    expect(planStart(interrupted, "clean", true).confirm).toBe(false);
  });

  test.each([absent, yours, pub] as const)(
    "%j takes an explicit migrate or introspect as asked",
    (state) => {
      expect(planStart(state, "migrate", true)).toEqual(
        only({ kind: "migrate" }),
      );
      expect(planStart(state, "introspect", true)).toEqual(
        only({ kind: "introspect" }),
      );
    },
  );
});
