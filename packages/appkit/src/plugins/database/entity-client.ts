import type { PluginExecuteConfig } from "shared";
import {
  classifyDatabaseError,
  DatabasePluginError,
  databaseErrorFromStatus,
  invalidDatabaseRequest,
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
import { DatabaseValidationError } from "../../errors";
import type { ExecutionResult } from "../../plugin/execution-result";
import { databaseReadDefaults, databaseWriteDefaults } from "./defaults";
import type { HookContext, MutationOperation } from "./hooks";
import type { MutationScope } from "./scope";
import type { EntityHooks } from "./types";

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
  readonly scope: MutationScope;
  readonly hooks?: EntityHooks;
  /** True once this client is bound to an already open transaction. */
  readonly transactionBound: boolean;
  /** Continue on the same table's client inside a new or reused transaction. */
  readonly runInTransaction: <T>(
    run: (entity: EntityClient) => Promise<T>,
  ) => Promise<T>;
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

/** A hook replaced the payload only if it returned an object to persist. */
function isReplacement(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

  async create(values: Row): Promise<Row> {
    this.assertUnfiltered("create");
    const hooks = this.ctx.hooks;
    const insert = (payload: Row, byHook = false) =>
      this.write(
        "create",
        payload,
        (dataPath, parsed) => dataPath.insert(this.ctx.table, parsed),
        byHook,
      );
    if (this.isDirect("create")) return insert(values);
    return this.mutate(
      "create",
      (entity) => entity.create(values),
      async (context) => {
        const payload = await this.runBefore(
          () => hooks?.beforeCreate?.(values, context),
          values,
        );
        const row = await insert(payload, payload !== values);
        await this.runHook(() => hooks?.afterCreate?.(row, context));
        return row;
      },
    );
  }

  update(id: IdValue, values: Row): Promise<Row | null> {
    const hooks = this.ctx.hooks;
    const apply = (payload: Row, byHook = false) =>
      this.write(
        "update",
        payload,
        (dataPath, parsed) =>
          dataPath.update(this.ctx.table, id, parsed, this.state.where),
        byHook,
      );
    if (this.isDirect("update")) return apply(values);
    return this.mutate(
      "update",
      (entity) => entity.update(id, values),
      async (context) => {
        const payload = await this.runBefore(
          () => hooks?.beforeUpdate?.(id, values, context),
          values,
        );
        const row = await apply(payload, payload !== values);
        // Matching no row is an ordinary outcome, not something to react to.
        if (row) await this.runHook(() => hooks?.afterUpdate?.(row, context));
        return row;
      },
    );
  }

  async upsert(values: Row, options: { onConflict: string }): Promise<Row> {
    this.assertUnfiltered("upsert");
    const hooks = this.ctx.hooks;
    const onConflict = options.onConflict;
    const apply = (payload: Row, byHook = false) =>
      this.write(
        "create",
        payload,
        (dataPath, parsed) =>
          dataPath.upsert(this.ctx.table, parsed, onConflict),
        byHook,
      );
    if (this.isDirect("upsert")) return apply(values);
    return this.mutate(
      "upsert",
      (entity) => entity.upsert(values, { onConflict }),
      async (context) => {
        const payload = await this.runBefore(
          () => hooks?.beforeUpsert?.(values, context),
          values,
        );
        // Which branch the database took stays invisible to the hook.
        const row = await apply(payload, payload !== values);
        await this.runHook(() => hooks?.afterUpsert?.(row, context));
        return row;
      },
    );
  }

  delete(id: IdValue): Promise<boolean> {
    const hooks = this.ctx.hooks;
    const remove = () =>
      this.run(
        "write",
        (dataPath) => dataPath.delete(this.ctx.table, id, this.state.where),
        databaseWriteDefaults,
      );
    if (this.isDirect("delete")) return remove();
    return this.mutate(
      "delete",
      (entity) => entity.delete(id),
      async (context) => {
        await this.runHook(() => hooks?.beforeDelete?.(id, context));
        const deleted = await remove();
        if (deleted) {
          await this.runHook(() => hooks?.afterDelete?.(id, context));
        }
        return deleted;
      },
    );
  }

  /** An insert matches no existing row, so a predicate could only be dropped. */
  private assertUnfiltered(operation: "create" | "upsert"): void {
    if (this.state.where !== undefined) {
      throw invalidDatabaseRequest(
        `${operation}() cannot follow where(); it does not select rows to change`,
      );
    }
  }

  /**
   * Go straight to the DataPath only when there is nothing to sequence and no
   * open transaction to join. A root client that skipped the second check would
   * commit on the pool while a transaction it cannot see is still open.
   */
  private isDirect(operation: MutationOperation): boolean {
    if (this.hasHooks(operation)) return false;
    return this.ctx.transactionBound || !this.ctx.scope.activeTransaction();
  }

  private hasHooks(operation: MutationOperation): boolean {
    const hooks = this.ctx.hooks;
    if (!hooks) return false;
    switch (operation) {
      case "create":
        return Boolean(hooks.beforeCreate ?? hooks.afterCreate);
      case "update":
        return Boolean(hooks.beforeUpdate ?? hooks.afterUpdate);
      case "upsert":
        return Boolean(hooks.beforeUpsert ?? hooks.afterUpsert);
      case "delete":
        return Boolean(hooks.beforeDelete ?? hooks.afterDelete);
    }
  }

  /**
   * Run one mutation atomically. A top-level call restarts itself on the
   * transaction-bound client, so hooks, validation, the mutation, and its after
   * hook commit or roll back together. An unhooked mutation reaches this only to
   * join an open transaction, and then runs without a frame or a hook context.
   */
  private async mutate<T>(
    operation: MutationOperation,
    restart: (entity: EntityClient) => Promise<T>,
    body: (context: HookContext) => Promise<T>,
  ): Promise<T> {
    if (this.ctx.transactionBound) {
      return this.ctx.scope.runMutation(this.ctx.table.$name, operation, () =>
        body(this.hookContext()),
      );
    }
    try {
      return await this.ctx.runInTransaction(restart);
    } catch (error) {
      if (error instanceof DatabaseValidationError) throw error;
      // BEGIN and COMMIT fail outside the inner classification boundary.
      throw classifyDatabaseError(error, "write");
    }
  }

  /** Resolve the surface at hook time so it cannot outlive its transaction. */
  private hookContext(): HookContext {
    const database = this.ctx.scope.activeTransaction();
    if (!database) throw new DatabasePluginError("INTERNAL", "write");
    return { entity: this.ctx.table.$name, app: { database } };
  }

  /** Substitute the payload a before hook returned, if it returned one. */
  private async runBefore(invoke: () => unknown, values: Row): Promise<Row> {
    const replacement = await this.runHook(invoke);
    if (replacement === undefined || replacement === null) return values;
    if (!isReplacement(replacement)) {
      throw new DatabasePluginError("INTERNAL", "write");
    }
    return replacement;
  }

  /** Keep a deliberate validation signal; collapse every other hook failure. */
  private async runHook(invoke: () => unknown): Promise<unknown> {
    try {
      return await invoke();
    } catch (error) {
      if (error instanceof DatabaseValidationError) throw error;
      throw classifyDatabaseError(error, "write");
    }
  }

  /** Validate caller values against the finalized trusted-write schema. */
  private async write<T>(
    kind: "create" | "update",
    values: Row,
    operation: (dataPath: DataPath, values: Row) => Promise<T>,
    // A payload a hook replaced is server-authored, so blaming the caller lies.
    byHook = false,
  ): Promise<T> {
    const rejection = byHook ? "INTERNAL" : "INVALID_REQUEST";
    if (kind === "update" && Object.keys(values).length === 0) {
      throw new DatabasePluginError(rejection, "write");
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
      throw new DatabasePluginError(rejection, "write");
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
