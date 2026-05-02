/**
 * Maps a Postgres catalog type to the AppKit column helper used by the renderer.
 *
 * `id()` is only emitted for generated int4 primary keys because it represents a
 * serial int4 PK. Generated non-PK columns and int8 identities must keep their
 * scalar helper or the generated schema changes shape.
 */
export function mapPostgresType(
  pgType: string,
  options: { serverGenerated?: boolean; isPrimaryKey?: boolean } = {},
): { helper: string; isIdShortcut: boolean } {
  if (
    options.serverGenerated &&
    options.isPrimaryKey &&
    (pgType === "int4" || pgType === "serial")
  ) {
    return { helper: "id()", isIdShortcut: true };
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
