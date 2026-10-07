/** The query a generated list route decodes; structured values travel as JSON. */
export interface DatabaseListQuery {
  readonly where?: unknown;
  readonly order?: unknown;
  readonly select?: readonly string[];
  readonly include?: unknown;
  readonly limit?: number;
  readonly offset?: number;
}

/** The query a generated detail route decodes: projection and includes only. */
export interface DatabaseRecordQuery {
  readonly select?: readonly string[];
  readonly include?: unknown;
}

// A fixed parameter order keeps equal requests on equal strings, whatever key
// order the caller's object literal happened to use.
const LIST_PARAMS = [
  "where",
  "order",
  "select",
  "include",
  "limit",
  "offset",
] as const;
const RECORD_PARAMS = ["select", "include"] as const;
const INTEGER_PARAMS: ReadonlySet<string> = new Set(["limit", "offset"]);

/** A known query failure, safe for the client to report without its input values. */
export class DatabaseQueryEncodingError extends TypeError {
  constructor(
    readonly parameter: string,
    message: string,
  ) {
    super(message);
    this.name = "DatabaseQueryEncodingError";
  }
}

/** JSON must not broaden a predicate or turn a non-finite operand into null. */
function jsonQueryValue(value: unknown, parameter: string): unknown {
  if (value === undefined) {
    throw new TypeError("Database query cannot contain undefined values");
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new DatabaseQueryEncodingError(
      parameter,
      "Database query numbers must be finite",
    );
  }
  return typeof value === "bigint" ? value.toString() : value;
}

function encode<T extends object>(
  params: T,
  names: readonly (keyof T & string)[],
): string {
  const search = new URLSearchParams();
  for (const name of names) {
    const value = params[name];
    if (value === undefined) continue;
    if (
      name === "where" &&
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0
    ) {
      throw new DatabaseQueryEncodingError(
        name,
        "Filter cannot be empty; omit where to list all rows",
      );
    }
    const serializable = jsonQueryValue(value, name);
    search.append(
      name,
      INTEGER_PARAMS.has(name)
        ? String(serializable)
        : JSON.stringify(serializable, (_key, child) =>
            jsonQueryValue(child, name),
          ),
    );
  }
  return search.toString();
}

/**
 * Encode `GET /:table` parameters the way `decodeListQuery` reads them: one
 * JSON value per structured parameter, decimal integers for pagination, and
 * nothing at all for an omitted parameter. Returns no leading `?`.
 */
export function encodeDatabaseListQuery(params: DatabaseListQuery): string {
  return encode(params, LIST_PARAMS);
}

/** Encode `GET /:table/:id` parameters the way `decodeDetailQuery` reads them. */
export function encodeDatabaseRecordQuery(params: DatabaseRecordQuery): string {
  return encode(params, RECORD_PARAMS);
}
