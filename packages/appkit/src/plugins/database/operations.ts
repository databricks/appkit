import type {
  DatabaseOperationMethod,
  PluginMap,
  WireInput,
  WireOutput,
} from "shared";
import type { z } from "zod";

import type {
  DatabaseRegistry,
  DatabaseRegistryEntry,
} from "../../database/contract";
import type { Schema as DatabaseSchema } from "../../database/schema-builder";
import type * as betaPlugins from "../beta-exports.generated";
import type * as gaPlugins from "../ga-exports.generated";
import type { DatabaseExports, EntityName } from "./entity-types";

/** HTTP methods an operation can answer; the browser client reads the same union. */
export type OperationMethod = DatabaseOperationMethod;

type Awaitable<T> = T | PromiseLike<T>;
type Schema = z.ZodType;
type SchemaSlot = Schema | undefined;

/** The authenticated caller. The HTTP boundary resolves it before any policy runs. */
export interface Actor {
  readonly id: string;
  readonly email?: string;
}

type SdkPluginFactory =
  | (typeof gaPlugins)[keyof typeof gaPlugins]
  | (typeof betaPlugins)[keyof typeof betaPlugins];

/**
 * The service-principal plugin exports an operation can call. A route module
 * cannot see which plugins the app registered, so each SDK plugin is optional
 * and custom plugins are absent. `database` is always registered and is the
 * same client as `db`.
 */
export type OperationAppKit = Readonly<
  Partial<PluginMap<ReturnType<SdkPluginFactory>[]>>
> & {
  readonly database: DatabaseExports;
};

/** What every authorization callback receives. */
export interface PolicyContext<In = unknown> {
  readonly actor: Actor;
  readonly db: DatabaseExports;
  readonly appkit: OperationAppKit;
  readonly input: In;
}

/** What `allow` and `execute` receive: the policy context and the loaded resource. */
export interface OperationContext<
  In = unknown,
  R = undefined,
> extends PolicyContext<In> {
  readonly resource: R;
}

/** An explicit refusal. `reason` stays on the server; HTTP and logs do not receive it. */
export interface PolicyDenial {
  readonly deny: "forbidden" | "not-found";
  readonly reason?: string;
}

/** Only literal `true` admits. False and an explicit denial refuse. */
export type PolicyDecision = true | false | PolicyDenial;

/** Admits a request from its actor and input alone. */
interface AllowPolicy<In = unknown> {
  readonly resource?: undefined;
  readonly allow: (
    context: OperationContext<In, undefined>,
  ) => Awaitable<PolicyDecision>;
}

/**
 * Loads one resource, then admits the request against it. A lookup that finds
 * nothing ends the request before `allow` runs, so `allow` and `execute` see
 * the lookup's non-null resource.
 */
interface ResourcePolicy<In, R> {
  readonly resource: (
    context: PolicyContext<In>,
  ) => Awaitable<R | null | undefined>;
  readonly allow: (
    context: OperationContext<In, NonNullable<Awaited<R>>>,
  ) => Awaitable<PolicyDecision>;
}

/** A reusable authorization rule, with or without a resource lookup. */
export type Policy<In = unknown, R = undefined> =
  | AllowPolicy<In>
  | ResourcePolicy<In, R>;

type Decision<In> = (context: PolicyContext<In>) => Awaitable<PolicyDecision>;

type Authorize<In, R> = Decision<In> | Policy<In, R>;

type Entry<E extends EntityName> =
  DatabaseRegistry[E] extends DatabaseRegistryEntry
    ? DatabaseRegistry[E]
    : never;
type PublicRow<E extends EntityName> = Entry<E>["publicRow"];
type Http<E extends EntityName> = Entry<E>["api"];
type Id<E extends EntityName> = PublicRow<E>[Http<E>["key"] &
  keyof PublicRow<E>];
/** A keyless entity has no id to default to, so its input must be explicit. */
type Keyed<E extends EntityName, T> = [Http<E>["key"]] extends [never]
  ? never
  : T;

/** The generated facet for a table with no writable public columns. */
type EmptyObject = Record<string, never>;
type HasUpdateField<T> = T extends EmptyObject
  ? false
  : [keyof T] extends [never]
    ? false
    : true;

/**
 * The inferred contract of each method: the parsed `input`, what `execute`
 * returns, and the successful response body before JSON encoding. Inputs come
 * from the HTTP facets, never from the trusted insert or update shapes. A
 * `null` result is a missing record; DELETE answers `false` for one.
 * PATCH and PUT have no default when the public update facet is empty.
 */
interface DefaultContract<E extends EntityName> {
  GET: {
    input: Keyed<E, { id: Id<E> }>;
    result: PublicRow<E> | null;
    output: PublicRow<E>;
  };
  POST: {
    input: Http<E>["insert"];
    result: PublicRow<E>;
    output: PublicRow<E>;
  };
  PATCH: {
    input: HasUpdateField<Http<E>["update"]> extends true
      ? Keyed<E, { id: Id<E>; changes: Http<E>["update"] }>
      : never;
    result: PublicRow<E> | null;
    output: PublicRow<E>;
  };
  PUT: {
    input: HasUpdateField<Http<E>["update"]> extends true
      ? Keyed<
          E,
          {
            id: Id<E>;
            values: Required<Exclude<Http<E>["update"], EmptyObject>>;
          }
        >
      : never;
    result: PublicRow<E> | null;
    output: PublicRow<E>;
  };
  DELETE: {
    input: Keyed<E, { id: Id<E> }>;
    result: boolean;
    output: void;
  };
}

type Contract<
  E extends EntityName,
  M extends OperationMethod,
> = DefaultContract<E>[M];

/** Methods whose `null` result means a missing record, whatever the output schema. */
type NullableMethod = "GET" | "PATCH" | "PUT";

type ParsedInput<
  E extends EntityName,
  M extends OperationMethod,
  I extends SchemaSlot,
> = [I] extends [Schema] ? z.output<I> : Contract<E, M>["input"];

type ExecuteResult<
  E extends EntityName,
  M extends OperationMethod,
  O extends SchemaSlot,
> = [O] extends [Schema]
  ? z.input<O> | (M extends NullableMethod ? null : never)
  : Contract<E, M>["result"];

type WireInputOf<
  E extends EntityName,
  M extends OperationMethod,
  I extends SchemaSlot,
> = [I] extends [Schema] ? z.input<I> : WireInput<Contract<E, M>["input"]>;

/**
 * A default body encodes bigint as a decimal string. An explicit output uses
 * its parsed JSON type, and `null` is a successful body only when that type
 * accepts it. DELETE has no body unless its output says otherwise.
 */
type WireOutputOf<
  E extends EntityName,
  M extends OperationMethod,
  O extends SchemaSlot,
> = [O] extends [Schema]
  ? null extends z.output<O>
    ? z.output<O>
    : M extends NullableMethod
      ? Exclude<z.output<O>, null>
      : z.output<O>
  : WireOutput<Contract<E, M>["output"]>;

/**
 * Everything `defineOperation` accepts besides its callbacks. Both overloads
 * intersect it directly: inference cannot see `input` through an `Omit` of
 * this conditional type, so an explicit input would silently become the default.
 */
type OperationFields<
  E extends EntityName,
  M extends OperationMethod,
  I extends SchemaSlot,
  O extends SchemaSlot,
  Name extends string,
> = {
  readonly name: Name & string;
  readonly entity: E;
  readonly method: M;
  readonly output?: O;
} & ([Contract<E, M>["input"]] extends [never]
  ? { readonly input: I & Schema }
  : { readonly input?: I });

/** What `defineOperation` accepts for one entity and method. */
type OperationOptions<
  E extends EntityName,
  M extends OperationMethod,
  I extends SchemaSlot,
  O extends SchemaSlot,
  R,
  Name extends string,
> = OperationFields<E, M, I, O, Name> & {
  readonly authorize: Authorize<ParsedInput<E, M, I>, R>;
  readonly execute: (
    context: OperationContext<
      ParsedInput<E, M, I>,
      [R] extends [undefined] ? undefined : NonNullable<Awaited<R>>
    >,
  ) => Awaitable<ExecuteResult<E, M, O>>;
};

/** One immutable operation descriptor. Nothing in it runs until a request does. */
export interface OperationDefinition<
  E extends EntityName,
  M extends OperationMethod,
  I extends SchemaSlot,
  O extends SchemaSlot,
  R,
  Name extends string,
> {
  readonly name: Name;
  readonly entity: E;
  readonly method: M;
  readonly input: I;
  readonly output: O;
  readonly authorize: Authorize<ParsedInput<E, M, I>, R>;
  readonly execute: (
    context: OperationContext<
      ParsedInput<E, M, I>,
      [R] extends [undefined] ? undefined : NonNullable<Awaited<R>>
    >,
  ) => Awaitable<ExecuteResult<E, M, O>>;
}

/** The JSON a caller sends to an operation; a bigint travels as a string or safe integer. */
export type OperationWireInput<Operation> =
  Operation extends OperationDefinition<
    infer E extends EntityName,
    infer M extends OperationMethod,
    infer I extends SchemaSlot,
    infer _O extends SchemaSlot,
    infer _R,
    infer _Name extends string
  >
    ? WireInputOf<E, M, I>
    : never;

/** The JSON a successful call answers with; a bigint travels as a decimal string. */
export type OperationWireOutput<Operation> =
  Operation extends OperationDefinition<
    infer E extends EntityName,
    infer M extends OperationMethod,
    infer _I extends SchemaSlot,
    infer O extends SchemaSlot,
    infer _R,
    infer _Name extends string
  >
    ? WireOutputOf<E, M, O>
    : never;

/** @internal What `defineOperation` produced; every field still needs validation. */
interface OperationCandidate {
  readonly name: unknown;
  readonly entity: unknown;
  readonly method: unknown;
  readonly input: unknown;
  readonly output: unknown;
  readonly authorize: unknown;
  readonly execute: unknown;
}

type RawFields<T> = { readonly [K in keyof T]?: unknown };

// A registered symbol, so a loader sees the tag across duplicated module copies.
const OPERATION = Symbol.for("@databricks/appkit/database/operation");

/**
 * Declare one database operation. `name` is its public identifier. The entity
 * and method infer the default input and output; `input` and `output` Zod
 * schemas override them. Definition is pure: it freezes a descriptor and
 * calls nothing.
 */
export function defineOperation<
  const Name extends string,
  E extends EntityName,
  M extends OperationMethod,
  I extends SchemaSlot,
  O extends SchemaSlot,
  R extends NonNullable<unknown>,
>(
  definition: OperationFields<E, M, I, O, Name> & {
    readonly authorize: ResourcePolicy<ParsedInput<E, M, I>, R>;
    readonly execute: (
      context: OperationContext<ParsedInput<E, M, I>, NonNullable<Awaited<R>>>,
    ) => Awaitable<ExecuteResult<E, M, O>>;
  },
): OperationDefinition<E, M, I, O, R, Name>;
export function defineOperation<
  const Name extends string,
  E extends EntityName,
  M extends OperationMethod,
  I extends SchemaSlot = undefined,
  O extends SchemaSlot = undefined,
>(
  definition: OperationOptions<E, M, I, O, undefined, Name>,
): OperationDefinition<E, M, I, O, undefined, Name>;
export function defineOperation(
  definition: RawFields<OperationCandidate>,
): OperationCandidate {
  // An untyped file may omit authorize; the loader reports it, nothing here fills it.
  const descriptor: OperationCandidate = {
    name: definition.name,
    entity: definition.entity,
    method: definition.method,
    input: definition.input,
    output: definition.output,
    authorize: definition.authorize,
    execute: definition.execute,
  };
  Object.defineProperty(descriptor, OPERATION, { value: true });
  return Object.freeze(descriptor);
}

/** @internal Whether `value` came from `defineOperation`, not whether it is valid. */
export function isOperationCandidate(
  value: unknown,
): value is OperationCandidate {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.hasOwn(value, OPERATION)
  );
}

/**
 * Declare a reusable authorization rule. Without `resource` it decides from
 * the actor and input. With `resource` it loads one record first; annotate
 * the lookup context to fix the input the policy needs. `allow` may return
 * `true`, `false`, or `{ deny }`.
 */
export function definePolicy<In = unknown>(
  policy: AllowPolicy<In>,
): AllowPolicy<In>;
export function definePolicy<const In, R>(
  policy: ResourcePolicy<In, R>,
): ResourcePolicy<In, R>;
export function definePolicy(
  policy: RawFields<ResourcePolicy<unknown, unknown>>,
): RawFields<ResourcePolicy<unknown, unknown>> {
  return Object.freeze(
    policy.resource === undefined
      ? { allow: policy.allow }
      : { resource: policy.resource, allow: policy.allow },
  );
}

/** One export a module loader found. `value` may be any export, not only an operation. */
export interface LocatedDeclaration {
  readonly file: string;
  readonly exportName: string;
  readonly value: unknown;
}

/**
 * The generated route entry. `schema` and each module stay lazy, so importing
 * the registry evaluates neither the schema nor an operation.
 */
export interface DatabaseRoutes {
  readonly schema: () => Promise<{ schema: DatabaseSchema }>;
  readonly modules: readonly {
    readonly file: string;
    readonly load: () => Promise<Record<string, unknown>>;
  }[];
}
