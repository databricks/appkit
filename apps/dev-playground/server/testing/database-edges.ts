/**
 * Test support for the playground's database operations: stand-ins for the two
 * external edges the database plugin talks to, so a test boots the real
 * plugin, routes registry, operations, and policies without Lakebase or a
 * workspace. Neither is a database or an identity provider.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http, { type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Schema } from "@databricks/appkit/beta";

type Table = Schema["$tables"][string];
type Row = Record<string, unknown>;
type Clause = Readonly<Record<string, unknown>>;

interface Read {
  readonly where?: Clause;
  readonly order?: Readonly<Record<string, "asc" | "desc">>;
  readonly select?: readonly string[];
  readonly include?: Readonly<Record<string, boolean | Read>>;
  readonly limit?: number;
  readonly offset?: number;
}

/** The data path the plugin reads and writes through, over plain arrays. */
export interface MemoryDataPath {
  select(table: Table, spec: Read): Promise<Row[]>;
  findOne(table: Table, id: unknown, spec?: Read): Promise<Row | null>;
  count(table: Table, where?: Clause): Promise<number>;
  insert(table: Table, values: Row): Promise<Row>;
  update(
    table: Table,
    id: unknown,
    values: Row,
    where?: Clause,
  ): Promise<Row | null>;
  upsert(): Promise<never>;
  delete(table: Table, id: unknown, where?: Clause): Promise<boolean>;
  raw(strings: TemplateStringsArray, ...values: unknown[]): Promise<Row[]>;
  transaction<T>(callback: (tx: MemoryDataPath) => Promise<T>): Promise<T>;
}

export interface MemoryDatabase {
  readonly dataPath: MemoryDataPath;
  /** Committed rows of one table, in insertion order. */
  rows(table: string): readonly Row[];
  /** Make the next insert into `table` fail as a driver error would. */
  failNextInsert(table: string): void;
}

type Store = Record<string, Row[]>;

/** The page size the real data path applies when a read has no limit. */
const DEFAULT_LIMIT = 50;

const isList = (value: unknown): value is readonly unknown[] =>
  Array.isArray(value);
const isClause = (value: unknown): value is Clause =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * An in-memory data path over the declared tables. Inserts fill serial ids
 * and `defaultNow()` timestamps and enforce unique columns and foreign keys;
 * deletes cascade along `onDelete("cascade")` keys. A transaction writes to a
 * copy that becomes the committed rows only if its callback resolves. Every
 * failure is a plain error, which AppKit answers with 500.
 */
export function memoryDatabase(schema: Schema): MemoryDatabase {
  const tables = Object.values(schema.$tables);
  let committed: Store = Object.fromEntries(
    tables.map((table) => [table.$name, []]),
  );
  let nextId = 1;
  const failing = new Set<string>();

  const tableNamed = (name: string): Table => {
    const table = tables.find((candidate) => candidate.$name === name);
    if (!table) throw new Error(`memory database: no table ${name}`);
    return table;
  };
  const keyOf = (table: Table): string => {
    const entry = Object.entries(table.$columns).find(
      ([, meta]) => meta.primaryKey,
    );
    if (!entry) throw new Error(`memory database: ${table.$name} has no key`);
    return entry[0];
  };

  /** One data path over the rows `store()` returns when it runs. */
  const build = (store: () => Store): MemoryDataPath => {
    const rowsOf = (table: Table): Row[] => store()[table.$name] ?? [];
    const write = (table: Table, rows: Row[]) => {
      store()[table.$name] = rows;
    };

    const project = (table: Table, row: Row, spec: Read): Row => {
      const names =
        spec.select ??
        Object.entries(table.$columns)
          .filter(([, meta]) => !meta.isPrivate)
          .map(([name]) => name);
      const projected: Row = Object.fromEntries(
        names.map((name) => [name, row[name]]),
      );
      for (const [name, option] of Object.entries(spec.include ?? {})) {
        if (option === false) continue;
        const relation = table.$relations.find((edge) => edge.name === name);
        if (!relation) throw new Error(`memory database: no relation ${name}`);
        const target = tableNamed(relation.targetTable);
        const related = rowsOf(target).filter(
          (candidate) =>
            candidate[relation.targetColumn] === row[relation.localColumn],
        );
        const nested = option === true ? {} : option;
        projected[name] =
          relation.cardinality === "toMany"
            ? read(target, related, nested)
            : related[0]
              ? project(target, related[0], nested)
              : null;
      }
      return projected;
    };

    const read = (table: Table, candidates: Row[], spec: Read): Row[] => {
      const offset = spec.offset ?? 0;
      return candidates
        .filter((row) => matches(row, spec.where))
        .sort((left, right) => {
          for (const [name, direction] of Object.entries(spec.order ?? {})) {
            const order = compare(left[name], right[name]);
            if (order !== 0) return direction === "desc" ? -order : order;
          }
          return 0;
        })
        .slice(offset, offset + (spec.limit ?? DEFAULT_LIMIT))
        .map((row) => project(table, row, spec));
    };

    const byKey = (table: Table, id: unknown, where?: Clause) =>
      rowsOf(table).find(
        (row) => row[keyOf(table)] === id && matches(row, where),
      );

    const remove = (table: Table, row: Row) => {
      write(
        table,
        rowsOf(table).filter((entry) => entry !== row),
      );
      for (const child of tables) {
        for (const [name, meta] of Object.entries(child.$columns)) {
          const fk = meta.fk;
          if (fk?.targetTable !== table.$name) continue;
          for (const dependent of rowsOf(child)) {
            if (dependent[name] !== row[fk.targetColumn]) continue;
            if (fk.onDelete !== "cascade") {
              throw new Error("memory database: foreign key violation");
            }
            remove(child, dependent);
          }
        }
      }
    };

    const check = (table: Table, row: Row, replacing?: Row) => {
      for (const [name, meta] of Object.entries(table.$columns)) {
        const value = row[name];
        if (value === null || value === undefined) continue;
        const taken = rowsOf(table).some(
          (other) => other !== replacing && other[name] === value,
        );
        if ((meta.unique || meta.primaryKey) && taken) {
          throw new Error("memory database: unique violation");
        }
        const fk = meta.fk;
        if (
          fk &&
          !rowsOf(tableNamed(fk.targetTable)).some(
            (target) => target[fk.targetColumn] === value,
          )
        ) {
          throw new Error("memory database: foreign key violation");
        }
      }
    };

    return {
      select: async (table, spec) => read(table, rowsOf(table), spec),
      findOne: async (table, id, spec = {}) => {
        const row = byKey(table, id, spec.where);
        return row ? project(table, row, spec) : null;
      },
      count: async (table, where) =>
        rowsOf(table).filter((row) => matches(row, where)).length,
      insert: async (table, values) => {
        if (failing.delete(table.$name)) {
          throw new Error(`memory database: forced ${table.$name} failure`);
        }
        const row: Row = {};
        for (const [name, meta] of Object.entries(table.$columns)) {
          row[name] =
            values[name] !== undefined
              ? values[name]
              : meta.storageKind === "id" || meta.storageKind === "bigid"
                ? nextId++
                : meta.defaultNow
                  ? new Date().toISOString()
                  : (meta.defaultValue ?? null);
        }
        check(table, row);
        write(table, [...rowsOf(table), row]);
        return { ...row };
      },
      update: async (table, id, values, where) => {
        const current = byKey(table, id, where);
        if (!current) return null;
        const next = { ...current, ...values };
        check(table, next, current);
        write(
          table,
          rowsOf(table).map((row) => (row === current ? next : row)),
        );
        return { ...next };
      },
      upsert: async () => {
        throw new Error("memory database: upsert is not supported");
      },
      delete: async (table, id, where) => {
        const row = byKey(table, id, where);
        if (row) remove(table, row);
        return row !== undefined;
      },
      // Setup runs `select 1`, then reads pg_catalog to confirm that every
      // declared column exists. This database holds exactly the declared ones.
      raw: async (strings) =>
        strings.join("?").includes("pg_catalog")
          ? tables.flatMap((table) =>
              Object.values(table.$columns).map((meta) => ({
                table_name: table.$name,
                column_name: meta.columnName,
                relation_kind: "r",
              })),
            )
          : [{ "?column?": 1 }],
      // AppKit joins nested transactions itself; one never reaches the edge.
      transaction: async () => {
        throw new Error("memory database: nested transaction");
      },
    };
  };

  return {
    dataPath: {
      ...build(() => committed),
      transaction: async (callback) => {
        const staged: Store = Object.fromEntries(
          Object.entries(committed).map(([name, rows]) => [name, [...rows]]),
        );
        const result = await callback(build(() => staged));
        committed = staged;
        return result;
      },
    },
    rows: (table) => committed[table] ?? [],
    failNextInsert: (table) => {
      failing.add(table);
    },
  };
}

function compare(left: unknown, right: unknown): number {
  if (left === right) return 0;
  if (left === null || left === undefined) return 1;
  if (right === null || right === undefined) return -1;
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  return String(left) < String(right) ? -1 : 1;
}

/** Equality, `in` lists, comparisons, and `and`/`or` groups. */
function matches(row: Row, where?: Clause): boolean {
  if (!where) return true;
  return Object.entries(where).every(([name, condition]) => {
    if ((name === "and" || name === "or") && isList(condition)) {
      const results = condition.map(
        (clause) => isClause(clause) && matches(row, clause),
      );
      return name === "and" ? results.every(Boolean) : results.some(Boolean);
    }
    const value = row[name];
    if (isList(condition)) return condition.includes(value);
    if (!isClause(condition)) return value === condition;
    return Object.entries(condition).every(([operator, operand]) => {
      switch (operator) {
        case "eq":
          return value === operand;
        case "neq":
          return value !== operand;
        case "in":
          return isList(operand) && operand.includes(value);
        case "gt":
          return compare(value, operand) > 0;
        case "gte":
          return compare(value, operand) >= 0;
        case "lt":
          return compare(value, operand) < 0;
        case "lte":
          return compare(value, operand) <= 0;
        default:
          throw new Error(`memory database: unsupported filter ${operator}`);
      }
    });
  });
}

/** A workspace user `currentUser.me` describes for one bearer token. */
export interface WorkspaceUser {
  readonly id: string;
  readonly userName: string;
}

export interface FakeWorkspace {
  /** Use as `DATABRICKS_HOST`. */
  readonly host: string;
  /**
   * Use as `DATABRICKS_CONFIG_FILE`: an empty profile file, so the SDK never
   * reads the developer's own `~/.databrickscfg`.
   */
  readonly configFile: string;
  /** Every path the workspace was asked for, in order. */
  readonly requests: readonly string[];
  close(): Promise<void>;
}

/**
 * A loopback HTTP server that answers only SCIM `Me`, naming the user whose
 * token the request bears and refusing any other token with 401. Every other
 * path is 404, so nothing reaches a real workspace.
 */
export async function fakeWorkspace(
  users: Readonly<Record<string, WorkspaceUser>>,
): Promise<FakeWorkspace> {
  const requests: string[] = [];
  const server: Server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    const user = token === undefined ? undefined : users[token];
    res.setHeader("content-type", "application/json");
    if (!req.url?.startsWith("/api/2.0/preview/scim/v2/Me")) {
      res.writeHead(404).end(JSON.stringify({ error_code: "NOT_FOUND" }));
    } else if (!user) {
      res.writeHead(401).end(JSON.stringify({ error_code: "UNAUTHENTICATED" }));
    } else {
      res.writeHead(200).end(
        JSON.stringify({
          ...user,
          active: true,
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fake workspace: no TCP address");
  }
  const profiles = await mkdtemp(path.join(tmpdir(), "fake-workspace-"));
  const configFile = path.join(profiles, ".databrickscfg");
  await writeFile(configFile, "");
  return {
    host: `http://127.0.0.1:${address.port}`,
    configFile,
    requests,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(profiles, { recursive: true, force: true });
    },
  };
}
