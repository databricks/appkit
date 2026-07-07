import { describe, expect, it } from "vitest";
import { mirrorStorageKind, resolveFkRef } from "../fk";
import { type ColumnRef, fk, type StorageKind } from "../index";

const ref: ColumnRef = {
  __isColumnRef: true,
  tableName: "users",
  columnName: "id",
};

describe("fk()", () => {
  it("produces an fk column with a placeholder integer storage", () => {
    const col = fk(ref);
    expect(col._spec.kind).toBe("fk");
    expect(col._meta.storageKind).toBe("integer");
    expect(col._meta.fkRef).toBe(ref);
  });

  it("accepts a thunk ref for forward/self references", () => {
    const col = fk(() => ref);
    expect(typeof col._meta.fkRef).toBe("function");
  });
});

describe("resolveFkRef()", () => {
  it("returns a direct ref unchanged", () => {
    expect(resolveFkRef(ref)).toBe(ref);
  });

  it("invokes a thunk ref", () => {
    expect(resolveFkRef(() => ref)).toBe(ref);
  });
});

describe("mirrorStorageKind()", () => {
  it("maps serial PK kinds to their plain integer storage", () => {
    const fromId: StorageKind = mirrorStorageKind("id");
    expect(fromId).toBe("integer");
    expect(mirrorStorageKind("bigid")).toBe("bigint");
  });

  it.each(["text", "uuid", "integer", "bigint", "boolean"] as const)(
    "passes %s through unchanged",
    (kind) => {
      expect(mirrorStorageKind(kind)).toBe(kind);
    },
  );
});
