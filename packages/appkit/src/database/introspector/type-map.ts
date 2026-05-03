/**
 * Maps a Postgres catalog type to the AppKit column helper used by the renderer.
 *
 * `id()` and `bigid()` are shortcuts for auto-incrementing primary keys
 * (Postgres `serial`/`bigserial` or equivalent identity columns). They are
 * only emitted when both `serverGenerated` AND `isPrimaryKey` are true so we
 * don't mis-render a generated-but-not-PK column or a non-generated PK.
 *
 * The `isIdShortcut: true` flag tells the renderer to skip the usual
 * `.notNull().primaryKey().default(...)` chain because the helper already
 * encodes all of that.
 */
export function mapPostgresType(
  pgType: string,
  options: { serverGenerated?: boolean; isPrimaryKey?: boolean } = {},
): { helper: string; isIdShortcut: boolean } {
  if (options.serverGenerated && options.isPrimaryKey) {
    if (pgType === "int4" || pgType === "serial") {
      return { helper: "id()", isIdShortcut: true };
    }
    if (pgType === "int8" || pgType === "bigserial") {
      return { helper: "bigid()", isIdShortcut: true };
    }
  }

  switch (pgType) {
    case "text":
      return { helper: "text()", isIdShortcut: false };
    case "varchar":
    case "bpchar":
      return { helper: "varchar()", isIdShortcut: false };
    case "int2":
    case "int4":
      return { helper: "integer()", isIdShortcut: false };
    case "int8":
      return { helper: "bigint()", isIdShortcut: false };
    case "bool":
      return { helper: "boolean()", isIdShortcut: false };
    case "timestamp":
      return { helper: "timestamp()", isIdShortcut: false };
    case "timestamptz":
      return { helper: "timestamp({ timezone: true })", isIdShortcut: false };
    case "uuid":
      return { helper: "uuid()", isIdShortcut: false };
    case "json":
    case "jsonb":
      return { helper: "jsonb()", isIdShortcut: false };
    default:
      return {
        helper: `text() /* TODO: pg type ${pgType} */`,
        isIdShortcut: false,
      };
  }
}
