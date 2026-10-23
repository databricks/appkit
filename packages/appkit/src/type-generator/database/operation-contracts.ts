import { z } from "zod";

import type {
  AppKitTable,
  ColumnMeta,
  Schema,
} from "../../database/schema-builder";
import { columnHttpCapabilities } from "../../plugins/database/crud/capabilities";
import type { validateOperationMetadata } from "../../plugins/database/operation-metadata";
import type { OperationMethod } from "../../plugins/database/operations";

type ValidatedOperation = ReturnType<
  typeof validateOperationMetadata
>["operations"][number];

/** A printable TypeScript type. Generated contracts never contain `any`. */
type TsType =
  | {
      readonly kind: "keyword";
      readonly name: "string" | "number" | "boolean" | "null" | "void";
    }
  /** A JSON column or `z.unknown()`: `unknown` on both sides of the wire. */
  | { readonly kind: "json" }
  /** `z.record` with plain string keys. */
  | {
      readonly kind: "record";
      readonly value: TsType;
      readonly readonly: boolean;
    }
  | { readonly kind: "literal"; readonly value: string | number | boolean }
  | {
      readonly kind: "array";
      readonly element: TsType;
      readonly readonly: boolean;
    }
  | {
      readonly kind: "object";
      readonly properties: readonly TsProperty[];
      readonly readonly: boolean;
    }
  | { readonly kind: "union"; readonly members: readonly TsType[] };

interface TsProperty {
  readonly name: string;
  readonly optional: boolean;
  readonly type: TsType;
}

/** The browser contract of one published operation, ready to print. */
export interface OperationContract {
  readonly name: string;
  readonly method: OperationMethod;
  readonly input: TsType;
  readonly output: TsType;
}

type ContractResult =
  | { readonly ok: true; readonly contract: OperationContract }
  | { readonly ok: false; readonly problems: readonly string[] };

/** Why one slot has no exact JSON type. The message names no user data. */
class ContractProblem extends Error {}

const keyword = (
  name: Extract<TsType, { kind: "keyword" }>["name"],
): TsType => ({ kind: "keyword", name });
const STRING = keyword("string");
const NUMBER = keyword("number");
const BOOLEAN = keyword("boolean");
const NULL = keyword("null");

function union(members: readonly TsType[]): TsType {
  const flat = members.flatMap((member) =>
    member.kind === "union" ? member.members : [member],
  );
  if (flat.length === 0) throw new ContractProblem("is an empty union");
  // `unknown` absorbs every other member, exactly as TypeScript reduces it.
  const json = flat.find((member) => member.kind === "json");
  if (json) return json;
  return flat.length === 1 ? flat[0] : { kind: "union", members: flat };
}

function object(properties: readonly TsProperty[], readonly = false): TsType {
  return { kind: "object", properties, readonly };
}

// ---------------------------------------------------------------------------
// Default contracts, from the same capability predicates the runtime compiles.
// ---------------------------------------------------------------------------

/** JSON carries a bigint as a decimal string out, and a string or safe integer in. */
function columnType(meta: ColumnMeta, direction: "input" | "output"): TsType {
  const scalar = ((): TsType => {
    switch (meta.kind) {
      case "string":
      case "uuid":
      case "date":
        return STRING;
      case "number":
        return NUMBER;
      case "bigint":
        return direction === "input" ? union([STRING, NUMBER]) : STRING;
      case "boolean":
        return BOOLEAN;
      case "enum":
        return meta.enumValues?.length
          ? union(meta.enumValues.map((value) => ({ kind: "literal", value })))
          : STRING;
      case "json":
      case "unknown":
        return { kind: "json" };
    }
  })();
  return meta.notNull ? scalar : union([scalar, NULL]);
}

function column(
  meta: ColumnMeta,
  direction: "input" | "output",
  optional: boolean,
): TsProperty {
  return {
    name: meta.columnName,
    optional,
    type: columnType(meta, direction),
  };
}

function noDefault(table: AppKitTable, method: OperationMethod): never {
  throw new ContractProblem(
    `needs an explicit schema: ${JSON.stringify(table.$name)} has no default ${method} input`,
  );
}

/** `{ id }`, `{ id, changes }`, `{ id, values }`, or the public create body. */
function defaultInput(table: AppKitTable, method: OperationMethod): TsType {
  const columns = Object.values(table.$columns).map((meta) => ({
    meta,
    can: columnHttpCapabilities(meta),
  }));
  const key = columns.find(({ can }) => can.publicKey)?.meta;
  const updatable = columns.filter(({ can }) => can.updatable);
  if (method === "POST") {
    return object(
      columns
        .filter(({ can }) => can.creatable)
        .map(({ meta }) =>
          column(meta, "input", !meta.notNull || meta.hasDefault),
        ),
    );
  }
  if (!key) return noDefault(table, method);
  const id: TsProperty = { ...column(key, "input", false), name: "id" };
  if (method === "GET" || method === "DELETE") return object([id]);
  if (updatable.length === 0) return noDefault(table, method);
  // PATCH changes any subset; PUT replaces every mutable public column.
  const patch = method === "PATCH";
  return object([
    id,
    {
      name: patch ? "changes" : "values",
      optional: false,
      type: object(updatable.map(({ meta }) => column(meta, "input", patch))),
    },
  ]);
}

/** Every public scalar column; a delete answers without a body. */
function defaultOutput(table: AppKitTable, method: OperationMethod): TsType {
  if (method === "DELETE") return keyword("void");
  return object(
    Object.values(table.$columns)
      .filter((meta) => columnHttpCapabilities(meta).selectable)
      .map((meta) => column(meta, "output", false)),
  );
}

// ---------------------------------------------------------------------------
// Explicit Zod contracts, through Zod's own JSON Schema conversion.
// ---------------------------------------------------------------------------

/**
 * Zod schema kinds whose JSON Schema states their exact `z.input` and
 * `z.output`. Anything else (tuples, intersections, catch, any, JSON values)
 * fails generation instead of printing a looser type.
 */
const RENDERABLE: ReadonlySet<string> = new Set([
  "array",
  "boolean",
  "default",
  "enum",
  "lazy",
  "literal",
  "nonoptional",
  "null",
  "nullable",
  "number",
  "object",
  "optional",
  "pipe",
  "prefault",
  "readonly",
  "record",
  "string",
  "union",
  "unknown",
]);

/** Marks a JSON node whose Zod value may be `undefined`; JSON Schema cannot say so. */
const MAY_BE_UNDEFINED = "x-appkit-undefined";

/** Marks the node of a `z.unknown()`, whose JSON Schema is the empty schema. */
const UNKNOWN = "x-appkit-unknown";

/** Marks the node of a `z.record` keyed by plain strings. */
const RECORD = "x-appkit-record";

/** Structure this renderer does not translate. */
const UNSUPPORTED_KEYWORDS = [
  "allOf",
  "not",
  "prefixItems",
  "propertyNames",
  "patternProperties",
  "if",
  "then",
  "else",
  "dependentSchemas",
  "unevaluatedProperties",
  "unevaluatedItems",
  "contains",
  "additionalItems",
  "$dynamicRef",
];

type JsonNode = Readonly<Record<string, unknown>>;

function isJsonNode(value: unknown): value is JsonNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A Zod 4 schema carries its definition under `_zod.def`. */
function isZodSchema(value: object): value is z.core.$ZodType {
  const internals: unknown = Reflect.get(value, "_zod");
  if (typeof internals !== "object" || internals === null) return false;
  const def: unknown = Reflect.get(internals, "def");
  return (
    typeof def === "object" &&
    def !== null &&
    typeof Reflect.get(def, "type") === "string"
  );
}

/** Zod's own reasons are safe to repeat; anything else may carry user text. */
function conversionFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  return /^[\w ]+ cannot be represented in JSON Schema$/.test(message)
    ? `has no JSON type (${message})`
    : "could not be converted to JSON Schema";
}

function literal(value: unknown): TsType {
  if (value === null) return NULL;
  if (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return { kind: "literal", value };
  }
  throw new ContractProblem("has a literal that is not a JSON scalar");
}

interface RenderScope {
  readonly root: JsonNode;
  /** References being rendered; meeting one again means recursion. */
  readonly refs: readonly string[];
}

interface Position {
  /** Only an object property can be absent, so only it may be undefined. */
  readonly undefinedAllowed: boolean;
  /** `.readonly()` applies to this node's own object or array. */
  readonly readonly: boolean;
}

const VALUE: Position = { undefinedAllowed: false, readonly: false };

function resolveRef(node: JsonNode, scope: RenderScope, at: Position): TsType {
  const ref = node.$ref;
  if (typeof ref !== "string") {
    throw new ContractProblem("has a malformed reference");
  }
  for (const sibling of ["type", "properties", "items", "anyOf", "oneOf"]) {
    if (sibling in node) {
      throw new ContractProblem("combines a reference with other structure");
    }
  }
  if (ref === "#" || scope.refs.includes(ref)) {
    throw new ContractProblem("is recursive");
  }
  const prefix = "#/$defs/";
  const name = ref.startsWith(prefix)
    ? ref.slice(prefix.length).replaceAll("~1", "/").replaceAll("~0", "~")
    : undefined;
  const defs = scope.root.$defs;
  if (name === undefined || !isJsonNode(defs) || !Object.hasOwn(defs, name)) {
    throw new ContractProblem("has a reference that cannot be resolved");
  }
  return render(defs[name], { ...scope, refs: [...scope.refs, ref] }, at);
}

function renderObject(node: JsonNode, scope: RenderScope, readonly: boolean) {
  const extra = node.additionalProperties;
  if (extra !== undefined && extra !== false) {
    throw new ContractProblem(
      "allows undeclared keys, which have no exact type",
    );
  }
  const properties = node.properties ?? {};
  const required = node.required ?? [];
  if (!isJsonNode(properties) || !Array.isArray(required)) {
    throw new ContractProblem("has a malformed object schema");
  }
  for (const name of required) {
    if (typeof name !== "string" || !Object.hasOwn(properties, name)) {
      throw new ContractProblem("requires a property it does not declare");
    }
  }
  return object(
    Object.entries(properties).map(([name, child]) => {
      const optional = !required.includes(name);
      return {
        name,
        optional,
        type: render(child, scope, {
          undefinedAllowed: optional,
          readonly: false,
        }),
      };
    }),
    readonly,
  );
}

/** Translate one JSON Schema node into the exact type Zod infers for it. */
function render(node: unknown, scope: RenderScope, at: Position): TsType {
  if (!isJsonNode(node)) {
    throw new ContractProblem("has a schema that is not a JSON object");
  }
  // `unknown` already includes `undefined`, wherever it sits.
  if (node[UNKNOWN] === true) return { kind: "json" };
  if (node[MAY_BE_UNDEFINED] === true && !at.undefinedAllowed) {
    throw new ContractProblem("may be undefined outside an object property");
  }
  if (node[RECORD] === true) {
    return {
      kind: "record",
      value: render(node.additionalProperties, scope, VALUE),
      readonly: at.readonly || node.readOnly === true,
    };
  }
  for (const keyword of UNSUPPORTED_KEYWORDS) {
    if (keyword in node) {
      throw new ContractProblem(`uses ${keyword}, which has no exact type`);
    }
  }
  const readonly = at.readonly || node.readOnly === true;
  if ("$ref" in node) return resolveRef(node, scope, { ...at, readonly });
  const members = node.anyOf ?? node.oneOf;
  if (members !== undefined) {
    if (!Array.isArray(members)) {
      throw new ContractProblem("has a malformed union");
    }
    // Readonly distributes over a union, and so does an absent property.
    return union(
      members.map((member) => render(member, scope, { ...at, readonly })),
    );
  }
  if ("const" in node) return literal(node.const);
  if (node.enum !== undefined) {
    if (!Array.isArray(node.enum)) {
      throw new ContractProblem("has a malformed enum");
    }
    return union(node.enum.map(literal));
  }
  switch (node.type) {
    case "string":
      return STRING;
    case "number":
    case "integer":
      return NUMBER;
    case "boolean":
      return BOOLEAN;
    case "null":
      return NULL;
    case "array":
      return {
        kind: "array",
        element: render(node.items, scope, VALUE),
        readonly,
      };
    case "object":
      return renderObject(node, scope, readonly);
    default:
      throw new ContractProblem("accepts any value");
  }
}

/** `z.input` or `z.output` of `schema`, or a {@link ContractProblem}. */
function zodType(schema: object, io: "input" | "output"): TsType {
  if (!isZodSchema(schema)) throw new ContractProblem("is not a Zod 4 schema");
  let json: unknown;
  try {
    json = z.toJSONSchema(schema, {
      io,
      // `.meta()` must not restate a type: only the definitions decide it.
      metadata: z.registry(),
      override: ({ zodSchema, jsonSchema }) => {
        const internals = zodSchema._zod;
        const { def } = internals;
        if (!RENDERABLE.has(def.type)) {
          throw new ContractProblem(
            `uses ${def.type}, which has no exact JSON type`,
          );
        }
        if (def.type === "unknown") jsonSchema[UNKNOWN] = true;
        if (def.type === "record") {
          const key = def.keyType._zod.def;
          if (key.type !== "string" || (key.checks?.length ?? 0) > 0) {
            throw new ContractProblem(
              "uses a record whose keys are not plain strings",
            );
          }
          jsonSchema[RECORD] = true;
        }
        if (io === "input" && "coerce" in def && def.coerce) {
          throw new ContractProblem("coerces its input from any value");
        }
        if (
          io === "input" &&
          def.type === "pipe" &&
          def.in._zod.def.type === "transform"
        ) {
          throw new ContractProblem("preprocesses its input from any value");
        }
        // A wrapper inherits its inner node's keys, so `.nonoptional()` must
        // also clear the mark its optional inner schema left.
        if (
          (io === "input" ? internals.optin : internals.optout) === "optional"
        ) {
          jsonSchema[MAY_BE_UNDEFINED] = true;
        } else {
          delete jsonSchema[MAY_BE_UNDEFINED];
        }
      },
    });
  } catch (error) {
    if (error instanceof ContractProblem) throw error;
    throw new ContractProblem(conversionFailure(error));
  }
  if (!isJsonNode(json)) throw new ContractProblem("has no JSON Schema");
  return render(json, { root: json, refs: [] }, VALUE);
}

/**
 * Derive the wire contract of one validated operation: an explicit Zod slot
 * from its JSON Schema, a default slot from the entity's HTTP capabilities.
 * Every slot that has no exact type is reported with its source and slot.
 */
export function operationContract(
  schema: Schema,
  operation: ValidatedOperation,
): ContractResult {
  const source = `${operation.file}#${operation.exportName}`;
  if (!Object.hasOwn(schema.$tables, operation.entity)) {
    return {
      ok: false,
      problems: [`${source} must name one entity in the database schema.`],
    };
  }
  const table = schema.$tables[operation.entity];
  const problems: string[] = [];
  const slot = (
    name: "input" | "output",
    explicit: object | undefined,
    fallback: (table: AppKitTable, method: OperationMethod) => TsType,
  ): TsType | undefined => {
    try {
      return explicit
        ? zodType(explicit, name)
        : fallback(table, operation.method);
    } catch (error) {
      if (!(error instanceof ContractProblem)) throw error;
      problems.push(`${source} ${name} ${error.message}.`);
      return undefined;
    }
  };
  const input = slot("input", operation.input, defaultInput);
  const output = slot("output", operation.output, defaultOutput);
  if (!input || !output) return { ok: false, problems };
  return {
    ok: true,
    contract: {
      name: operation.name,
      method: operation.method,
      input,
      output,
    },
  };
}

function printType(type: TsType, indent: string): string {
  switch (type.kind) {
    case "keyword":
      return type.name;
    case "json":
      return "unknown";
    case "record":
      return `{ ${type.readonly ? "readonly " : ""}[key: string]: ${printType(type.value, indent)} }`;
    case "literal":
      return JSON.stringify(type.value);
    case "union":
      return type.members
        .map((member) => printType(member, indent))
        .join(" | ");
    case "array": {
      const element = printType(type.element, indent);
      return `${type.readonly ? "readonly " : ""}${type.element.kind === "union" ? `(${element})` : element}[]`;
    }
    case "object": {
      if (type.properties.length === 0) {
        return type.readonly
          ? "Readonly<Record<string, never>>"
          : "Record<string, never>";
      }
      const inner = `${indent}  `;
      const modifier = type.readonly ? "readonly " : "";
      const lines = type.properties.map(
        (property) =>
          `${inner}${modifier}${JSON.stringify(property.name)}${property.optional ? "?" : ""}: ${printType(property.type, inner)};`,
      );
      return `{\n${lines.join("\n")}\n${indent}}`;
    }
  }
}

/** The global interface the UI reads. Empty when no operation is published. */
export function renderOperationTypes(
  contracts: readonly OperationContract[],
): string {
  const entries = [...contracts]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(
      (contract) => `    ${JSON.stringify(contract.name)}: {
      method: ${JSON.stringify(contract.method)};
      input: ${printType(contract.input, "      ")};
      output: ${printType(contract.output, "      ")};
    };`,
    );
  const body = entries.length > 0 ? `\n${entries.join("\n")}\n  ` : "";
  return `// Auto-generated by AppKit - DO NOT EDIT

declare global {
  interface DatabricksAppKitDatabaseOperations {${body}}
}

export {};
`;
}
