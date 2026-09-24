import { describe, expect, test } from "vitest";

import { isPlainObject as scopedIsPlainObject } from "../../context/scoped-api";
import { isPlainObject as pluginIsPlainObject } from "../../plugin/plugin";
import { isPlainObject as crudIsPlainObject } from "../../plugins/database/crud/contract";
import { isPlainObject } from "../is-plain-object";

describe.each([
  { name: "utility", check: isPlainObject },
  { name: "scoped API export", check: scopedIsPlainObject },
  { name: "plugin export", check: pluginIsPlainObject },
  { name: "CRUD export", check: crudIsPlainObject },
])("$name", ({ check }) => {
  test("accepts object literals and null-prototype records", () => {
    expect(check({ value: 1 })).toBe(true);
    expect(check(Object.create(null))).toBe(true);
  });

  test("rejects non-objects and objects with other prototypes", () => {
    class Instance {}
    for (const value of [
      null,
      undefined,
      false,
      0,
      "text",
      Symbol("value"),
      1n,
      () => {},
      [],
      new Date(),
      new Map(),
      new Instance(),
      Object.create({ value: 1 }),
    ]) {
      expect(check(value)).toBe(false);
    }
  });
});

test("CRUD keeps its explicit array rejection regardless of the prototype", () => {
  for (const prototype of [Object.prototype, null]) {
    const array = Object.setPrototypeOf([], prototype);
    expect(isPlainObject(array)).toBe(true);
    expect(scopedIsPlainObject(array)).toBe(true);
    expect(pluginIsPlainObject(array)).toBe(true);
    expect(crudIsPlainObject(array)).toBe(false);
  }
});
