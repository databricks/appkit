import { describe, expect, test } from "vitest";

import { DatabasePluginError } from "../../../../database/errors";
import { resolveCrudExposure } from "../exposure";

const tables = ["notes", "audits"];

describe("generated API configuration diagnostics", () => {
  test.each([
    [null, "api must be true, false, or a configuration object"],
    [[], "api must be true, false, or a configuration object"],
    ["false", "api must be true, false, or a configuration object"],
    [new Date(), "api must be a plain configuration object"],
    [
      { write: false },
      'Unknown option "api.write". Allowed options: tables, writes',
    ],
    [{ tables: "notes" }, "api.tables must be an array of names"],
    [{ tables: [1] }, "api.tables must contain only string names"],
    [
      { tables: ["missing"] },
      'api.tables contains unsupported name "missing". Allowed names: "notes", "audits"',
    ],
    [
      { tables: ["notes", "notes"] },
      'api.tables contains duplicate name "notes"',
    ],
    [
      { writes: null },
      "api.writes must be true, false, or a configuration object",
    ],
    [{ writes: new Date() }, "api.writes must be a plain configuration object"],
    [
      { writes: { operation: [] } },
      'Unknown option "api.writes.operation". Allowed options: tables, operations',
    ],
    [
      { writes: { tables: false } },
      "api.writes.tables must be an array of names",
    ],
    [
      { tables: ["notes"], writes: { tables: ["audits"] } },
      'api.writes.tables contains unsupported name "audits". Allowed names: "notes"',
    ],
    [
      { writes: { operations: "create" } },
      "api.writes.operations must be an array of names",
    ],
    [
      { writes: { operations: ["upsert"] } },
      'api.writes.operations contains unsupported name "upsert". Allowed names: "create", "update", "delete"',
    ],
    [
      { writes: { operations: ["create", "create"] } },
      'api.writes.operations contains duplicate name "create"',
    ],
  ])(
    "explains invalid api=%j without changing the client error",
    (api, message) => {
      let caught: unknown;
      try {
        resolveCrudExposure(api, tables);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(DatabasePluginError);
      expect(caught).toMatchObject({
        category: "SETUP_FAILED",
        phase: "setup",
        message: expect.stringContaining(message),
        clientMessage: "Database setup failed",
        details: undefined,
      });
    },
  );

  test.each([undefined, true, {}])(
    "explains invalid table names with api=%j",
    (api) => {
      expect(() => resolveCrudExposure(api, ["_events"])).toThrow(
        'Table "_events" cannot be exposed through api',
      );
      expect(() => resolveCrudExposure(api, ["_events"])).toThrow(
        "Rename the table, exclude it with api.tables, or set api: false",
      );
    },
  );

  test("names both conflicting tables and how to fix them", () => {
    expect(() => resolveCrudExposure(undefined, ["notes", "Notes"])).toThrow(
      'Tables "notes" and "Notes" conflict in api because routes are case-insensitive. Rename a table, select only one with api.tables, or set api: false',
    );
  });

  test("accepts route names at the documented boundary", () => {
    const declared = ["a", "Notes_2026-archive", "n".repeat(64)];
    expect(resolveCrudExposure(undefined, declared).tables).toEqual(declared);
    expect(() => resolveCrudExposure(undefined, ["n".repeat(65)])).toThrow(
      "at most 64 characters",
    );
  });

  test("accepts null-prototype configuration objects", () => {
    const api = Object.assign(Object.create(null), {
      writes: Object.assign(Object.create(null), { operations: ["create"] }),
    });
    const exposure = resolveCrudExposure(api, tables);
    expect(exposure.tables).toEqual(tables);
    expect([...exposure.writes.entries()]).toEqual([
      ["notes", new Set(["create"])],
      ["audits", new Set(["create"])],
    ]);
  });
});
