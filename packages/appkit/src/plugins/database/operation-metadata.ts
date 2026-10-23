import { isOperationCandidate, type LocatedDeclaration } from "./operations";

/** HTTP methods a named operation can answer. */
const METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"] as const;

/**
 * A public operation name is one URL segment. Dots separate its parts, and
 * the character set matches the table names the database routes already accept.
 */
const OPERATION_NAME =
  /^[A-Za-z][A-Za-z0-9_-]{0,63}(?:\.[A-Za-z][A-Za-z0-9_-]{0,63})*$/;

/** Longest operation name, so a request path stays bounded. */
export const MAX_OPERATION_NAME_LENGTH = 255;

/** Names a plain object cannot hold as its own key, as the boot payload does. */
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  "constructor",
  "prototype",
]);

/** Metadata both the runtime and the generator can trust. Callbacks stay uncalled. */
interface ValidatedOperation {
  readonly file: string;
  readonly exportName: string;
  readonly name: string;
  readonly entity: string;
  readonly method: (typeof METHODS)[number];
  readonly input: object | undefined;
  readonly output: object | undefined;
  readonly authorize:
    | ((...args: never[]) => unknown)
    | {
        readonly allow: (...args: never[]) => unknown;
        readonly resource?: (...args: never[]) => unknown;
      };
  readonly execute: (...args: never[]) => unknown;
}

/** Why a declaration was not published, with the export it came from. */
interface OperationMetadataIssue {
  readonly file: string;
  readonly exportName: string;
  readonly code:
    | "not-operation"
    | "name"
    | "entity"
    | "method"
    | "input"
    | "output"
    | "authorize"
    | "execute"
    | "duplicate";
  readonly message: string;
}

/**
 * `skipped` lists declarations whose only problem is missing authorization;
 * the runtime warns and serves the rest. `errors` lists malformed or duplicate
 * declarations; any error blocks the whole registry.
 */
interface OperationMetadataResult {
  readonly operations: readonly ValidatedOperation[];
  readonly skipped: readonly OperationMetadataIssue[];
  readonly errors: readonly OperationMetadataIssue[];
}

function issue(
  located: LocatedDeclaration,
  code: OperationMetadataIssue["code"],
  message: string,
): OperationMetadataIssue {
  return {
    file: located.file,
    exportName: located.exportName,
    code,
    message,
  };
}

function source(located: LocatedDeclaration): string {
  return `${located.file}#${located.exportName}`;
}

/** A Zod schema is an object with a callable safeParse. Nothing else is read. */
function isSchema(value: unknown): value is object {
  if (typeof value !== "object" || value === null) return false;
  return typeof Reflect.get(value, "safeParse") === "function";
}

function readFields(value: object): Record<string, unknown> {
  return {
    name: Reflect.get(value, "name"),
    entity: Reflect.get(value, "entity"),
    method: Reflect.get(value, "method"),
    input: Reflect.get(value, "input"),
    output: Reflect.get(value, "output"),
    authorize: Reflect.get(value, "authorize"),
    execute: Reflect.get(value, "execute"),
  };
}

/**
 * Check located exports once. A non-operation export is ignored. A descriptor
 * whose only problem is missing authorization is skipped. Every malformed field
 * is an error, and a valid name counts toward duplicates even when its
 * declaration is skipped. The result keeps declaration order and calls no
 * schema or callback.
 */
export function validateOperationMetadata(
  located: readonly LocatedDeclaration[],
  entities: ReadonlySet<string>,
): OperationMetadataResult {
  const operations: ValidatedOperation[] = [];
  const skipped: OperationMetadataIssue[] = [];
  const errors: OperationMetadataIssue[] = [];
  const seen = new Map<string, LocatedDeclaration>();

  for (const entry of located) {
    if (!isOperationCandidate(entry.value)) continue;
    const fields = readFields(entry.value);
    const problems: OperationMetadataIssue[] = [];

    const name =
      typeof fields.name === "string" &&
      fields.name.length <= MAX_OPERATION_NAME_LENGTH &&
      OPERATION_NAME.test(fields.name) &&
      !RESERVED_NAMES.has(fields.name)
        ? fields.name
        : undefined;
    if (name === undefined) {
      problems.push(
        issue(
          entry,
          "name",
          typeof fields.name === "string" && RESERVED_NAMES.has(fields.name)
            ? `${source(entry)} cannot use the reserved operation name ${JSON.stringify(fields.name)}.`
            : `${source(entry)} must name the operation with letters, digits, "_", "-", and dots: at most 64 characters per part and ${MAX_OPERATION_NAME_LENGTH} in total.`,
        ),
      );
    } else {
      const previous = seen.get(name);
      if (previous) {
        problems.push(
          issue(
            entry,
            "duplicate",
            `${source(entry)} repeats operation name ${JSON.stringify(name)}, already exported by ${source(previous)}.`,
          ),
        );
      } else {
        seen.set(name, entry);
      }
    }
    if (typeof fields.entity !== "string" || !entities.has(fields.entity)) {
      problems.push(
        issue(
          entry,
          "entity",
          `${source(entry)} must name one entity in the database schema.`,
        ),
      );
    }
    if (
      typeof fields.method !== "string" ||
      !METHODS.includes(fields.method as (typeof METHODS)[number])
    ) {
      problems.push(
        issue(
          entry,
          "method",
          `${source(entry)} must use GET, POST, PATCH, PUT, or DELETE.`,
        ),
      );
    }
    if (fields.input !== undefined && !isSchema(fields.input)) {
      problems.push(
        issue(entry, "input", `${source(entry)} input must be a Zod schema.`),
      );
    }
    if (fields.output !== undefined && !isSchema(fields.output)) {
      problems.push(
        issue(entry, "output", `${source(entry)} output must be a Zod schema.`),
      );
    }
    if (typeof fields.execute !== "function") {
      problems.push(
        issue(
          entry,
          "execute",
          `${source(entry)} must provide an execute function.`,
        ),
      );
    }

    const unauthorized = fields.authorize === undefined;
    if (unauthorized) {
      skipped.push(
        issue(
          entry,
          "authorize",
          `${source(entry)} has no authorization and was skipped.`,
        ),
      );
    } else if (typeof fields.authorize !== "function") {
      const policy = fields.authorize;
      const allow =
        typeof policy === "object" && policy !== null
          ? Reflect.get(policy, "allow")
          : undefined;
      const resource =
        typeof policy === "object" && policy !== null
          ? Reflect.get(policy, "resource")
          : undefined;
      if (
        typeof allow !== "function" ||
        (resource !== undefined && typeof resource !== "function")
      ) {
        problems.push(
          issue(
            entry,
            "authorize",
            `${source(entry)} authorization must be a function or a policy with a callable allow rule.`,
          ),
        );
      }
    }

    errors.push(...problems);
    if (problems.length > 0 || unauthorized || name === undefined) continue;

    const authorize = fields.authorize as ValidatedOperation["authorize"];
    operations.push({
      file: entry.file,
      exportName: entry.exportName,
      name,
      entity: fields.entity as string,
      method: fields.method as (typeof METHODS)[number],
      input: fields.input as object | undefined,
      output: fields.output as object | undefined,
      authorize,
      execute: fields.execute as (...args: never[]) => unknown,
    });
  }

  return { operations, skipped, errors };
}
