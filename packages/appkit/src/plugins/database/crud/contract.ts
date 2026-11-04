import { DatabasePluginError } from "../../../database/errors";
import { isPlainObject as hasPlainObjectPrototype } from "../../../utils/is-plain-object";
import { MAX_SERIALIZED_DEPTH, MAX_SERIALIZED_NODES } from "../defaults";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

interface SanitizeState {
  nodes: number;
  readonly ancestors: Set<object>;
}

/** A bare object literal; a `Date`, class instance, or `Map` is not JSON. */
export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return hasPlainObjectPrototype(value);
}

function rejectUnboundedJson(): never {
  throw new DatabasePluginError("INVALID_REQUEST", "write");
}

function countNode(depth: number, state: SanitizeState): void {
  state.nodes += 1;
  if (state.nodes > MAX_SERIALIZED_NODES || depth > MAX_SERIALIZED_DEPTH) {
    rejectUnboundedJson();
  }
}

/** Walk a container while its ancestors are tracked, so a cycle cannot pass. */
function enterObject<T>(
  value: object,
  state: SanitizeState,
  visit: () => T,
): T {
  if (state.ancestors.has(value)) rejectUnboundedJson();
  state.ancestors.add(value);
  try {
    return visit();
  } finally {
    state.ancestors.delete(value);
  }
}

/** Accept caller JSON only where it is already a finite JSON value. */
function sanitizeJson(
  value: unknown,
  depth: number,
  state: SanitizeState,
): JsonValue {
  countNode(depth, state);
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) rejectUnboundedJson();
    return value;
  }
  if (Array.isArray(value)) {
    return enterObject(value, state, () =>
      value.map((item) => sanitizeJson(item, depth + 1, state)),
    );
  }
  if (!isPlainObject(value)) rejectUnboundedJson();
  return enterObject(value, state, () => {
    // A null prototype keeps `__proto__` an ordinary key instead of a setter.
    const out: Record<string, JsonValue> = Object.create(null);
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) continue;
      out[key] = sanitizeJson(child, depth + 1, state);
    }
    return out;
  });
}

/** Copy finite acyclic JSON, bounded by depth and node count. */
export function boundedJson(value: unknown): JsonValue {
  return sanitizeJson(value, 0, { nodes: 0, ancestors: new Set() });
}
