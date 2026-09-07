import type { PluginExecuteConfig } from "shared";

import {
  classifyDatabaseError,
  DatabasePluginError,
  databaseErrorFromStatus,
} from "../../database/errors";
import type {
  DataPath,
  IdValue,
  IncludeSpec,
  OrderSpec,
  QuerySpec,
  Row,
  WhereClause,
} from "../../database/runtime";
import {
  andWhere,
  validateLimit,
  validateOffset,
} from "../../database/runtime/data-path";
import type { AppKitTable } from "../../database/schema-builder";
import type { ExecutionResult } from "../../plugin/execution-result";
import { databaseReadDefaults, databaseWriteDefaults } from "./defaults";

/** Apply AppKit execution policy to an entity operation. */
export type EntityExecute = <T>(
  fn: (signal?: AbortSignal) => Promise<T>,
  options: { default: PluginExecuteConfig; user?: PluginExecuteConfig },
) => Promise<ExecutionResult<T>>;

/** Runtime dependencies shared by immutable clients for one table. */
export interface EntityClientContext {
  readonly table: AppKitTable;
  readonly getDataPath: () => DataPath;
  readonly execute: EntityExecute;
  readonly assertActive: () => void;
}

/** Clone plain acyclic input so caller mutation cannot change a built query. */
function snapshotPlain<T>(value: T, seen = new Set<object>()): T {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (typeof value !== "object") {
    throw new DatabasePluginError("INVALID_REQUEST", "read");
  }
  if (seen.has(value)) throw new DatabasePluginError("INVALID_REQUEST", "read");
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new DatabasePluginError("INVALID_REQUEST", "read");
  seen.add(value);
  const copy = (
    Array.isArray(value)
      ? value.map((item) => snapshotPlain(item, seen))
      : Object.fromEntries(
          Object.entries(value).map(([key, item]) => [
            key,
            snapshotPlain(item, seen),
          ]),
        )
  ) as T;
  seen.delete(value);
  return copy;
}

/** Report eager fluent-input failures through the public read phase. */
function validateReadInput<T>(validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    throw classifyDatabaseError(error, "read");
  }
}

/**
 * Plugin-facing client that composes immutable query state. The DataPath remains
 * the schema-aware validation and execution boundary.
 */
export class EntityClient {
  constructor(
    private readonly ctx: EntityClientContext,
    private readonly state: QuerySpec = {},
  ) {}

  private clone(state: QuerySpec): EntityClient {
    return new EntityClient(this.ctx, state);
  }

  /** Snapshot and compose predicates; the adapter validates columns/operators. */
  where(filter: WhereClause): EntityClient {
    const snapshot = snapshotPlain(filter);
    return this.clone({
      ...this.state,
      where: andWhere(this.state.where, snapshot),
    });
  }

  /** Merge ordering, replacing the direction for repeated columns. */
  order(order: OrderSpec): EntityClient {
    const snapshot = snapshotPlain(order);
    return this.clone({
      ...this.state,
      order: { ...this.state.order, ...snapshot },
    });
  }

  select(columns: readonly string[]): EntityClient {
    return this.clone({ ...this.state, select: snapshotPlain(columns) });
  }

  /** Merge relation includes, replacing repeated relation options. */
  include(include: IncludeSpec): EntityClient {
    const snapshot = snapshotPlain(include);
    return this.clone({
      ...this.state,
      include: { ...this.state.include, ...snapshot },
    });
  }

  limit(limit: number): EntityClient {
    return validateReadInput(() =>
      this.clone({ ...this.state, limit: validateLimit(limit) }),
    );
  }

  offset(offset: number): EntityClient {
    return validateReadInput(() =>
      this.clone({ ...this.state, offset: validateOffset(offset) }),
    );
  }

  /** Execute a collection read; DataPath applies the default upper bound. */
  async toArray(): Promise<Row[]> {
    return this.run("read", (dataPath) =>
      dataPath.select(this.ctx.table, this.state),
    );
  }

  async first(): Promise<Row | null> {
    return (await this.limit(1).toArray())[0] ?? null;
  }

  find(id: IdValue): Promise<Row | null> {
    return this.run("read", (dataPath) =>
      dataPath.findOne(this.ctx.table, id, {
        where: this.state.where,
        select: this.state.select,
        include: this.state.include,
      }),
    );
  }

  count(): Promise<number> {
    return this.run("read", (dataPath) =>
      dataPath.count(this.ctx.table, this.state.where),
    );
  }

  create(values: Row): Promise<Row> {
    return this.write("create", values, (dataPath, payload) =>
      dataPath.insert(this.ctx.table, payload),
    );
  }

  update(id: IdValue, values: Row): Promise<Row | null> {
    return this.write("update", values, (dataPath, payload) =>
      dataPath.update(this.ctx.table, id, payload),
    );
  }

  upsert(values: Row, options: { onConflict: string }): Promise<Row> {
    const onConflict = options.onConflict;
    return this.write("create", values, (dataPath, payload) =>
      dataPath.upsert(this.ctx.table, payload, onConflict),
    );
  }

  delete(id: IdValue): Promise<boolean> {
    return this.run(
      "write",
      (dataPath) => dataPath.delete(this.ctx.table, id),
      databaseWriteDefaults,
    );
  }

  /** Validate caller values against the finalized trusted-write schema. */
  private async write<T>(
    kind: "create" | "update",
    values: Row,
    operation: (dataPath: DataPath, values: Row) => Promise<T>,
  ): Promise<T> {
    if (kind === "update" && Object.keys(values).length === 0) {
      throw new DatabasePluginError("INVALID_REQUEST", "write");
    }
    let parsed: Row;
    try {
      const validator = (
        kind === "create"
          ? this.ctx.table.$insertSchema
          : this.ctx.table.$updateSchema
      ) as { parse(value: unknown): Row };
      parsed = validator.parse(values);
    } catch {
      throw new DatabasePluginError("INVALID_REQUEST", "write");
    }
    return this.run(
      "write",
      (dataPath) => operation(dataPath, parsed),
      databaseWriteDefaults,
    );
  }

  /** Execute through AppKit interceptors and expose only safe failures. */
  private async run<T>(
    phase: "read" | "write",
    operation: (dataPath: DataPath) => Promise<T>,
    defaults: PluginExecuteConfig = databaseReadDefaults,
  ): Promise<T> {
    try {
      this.ctx.assertActive();
    } catch (error) {
      throw classifyDatabaseError(error, phase);
    }
    const result = await this.ctx.execute(
      async () => {
        try {
          this.ctx.assertActive();
          return await operation(this.ctx.getDataPath());
        } catch (error) {
          throw classifyDatabaseError(error, phase);
        }
      },
      { default: defaults },
    );
    if (result.ok) return result.data;
    throw databaseErrorFromStatus(result.status, phase);
  }
}
