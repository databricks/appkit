import { ColumnBuilder } from "./columns";
import type { ColumnRef, FkRef, StorageKind } from "./types";

/** Declare foreign-key to another column. */
export function fk(ref: FkRef): ColumnBuilder {
  const builder = new ColumnBuilder({ kind: "fk" }, "int4", "number");
  builder._meta.fkRef = ref;
  return builder;
}

export function resolveFkRef(ref: FkRef): ColumnRef {
  return typeof ref === "function" ? ref() : ref;
}

/** A serial PK target stores as its plain integer type on the FK side. */
export function mirrorStorageKind(targetStorage: StorageKind): StorageKind {
  if (targetStorage === "id") return "integer";
  if (targetStorage === "bigid") return "bigint";
  return targetStorage;
}
