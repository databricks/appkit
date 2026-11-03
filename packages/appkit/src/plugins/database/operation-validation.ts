import type { DatabaseErrorDetail } from "shared";
import { z } from "zod";

type Node = Readonly<Record<string, unknown>>;

function node(value: unknown): value is Node {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Zod 4's structural marker also works across separately loaded module copies. */
function isSchema(value: object): value is z.core.$ZodType {
  const internal: unknown = Reflect.get(value, "_zod");
  return (
    node(internal) &&
    node(internal.def) &&
    typeof internal.def.type === "string"
  );
}

function resolve(value: unknown, root: Node, depth = 0): Node[] {
  if (!node(value) || depth > 20) return [];
  if (typeof value.$ref === "string") {
    if (!value.$ref.startsWith("#/")) return [];
    let target: unknown = root;
    for (const key of value.$ref.slice(2).split("/")) {
      const decoded = key.replaceAll("~1", "/").replaceAll("~0", "~");
      target =
        node(target) && Object.hasOwn(target, decoded)
          ? target[decoded]
          : undefined;
    }
    return resolve(target, root, depth + 1);
  }
  const branches = value.anyOf ?? value.oneOf ?? value.allOf;
  return Array.isArray(branches)
    ? branches.flatMap((branch) => resolve(branch, root, depth + 1))
    : [value];
}

/** Only declared property names and array indices can appear in public errors. */
function declaredPath(
  root: Node | undefined,
  path: unknown,
): { path: string[]; exact: boolean } {
  if (!root || !Array.isArray(path)) return { path: ["input"], exact: false };
  let candidates = resolve(root, root);
  const safe: string[] = [];
  for (const part of path.slice(0, 20)) {
    const next = candidates.flatMap((candidate) => {
      if (
        typeof part === "string" &&
        part.length <= 500 &&
        node(candidate.properties) &&
        Object.hasOwn(candidate.properties, part)
      ) {
        return resolve(candidate.properties[part], root);
      }
      if (
        typeof part === "number" &&
        Number.isSafeInteger(part) &&
        part >= 0 &&
        candidate.type === "array"
      ) {
        return resolve(candidate.items, root);
      }
      return [];
    });
    // Records, catchalls, and custom issue paths may contain caller values.
    if (next.length === 0)
      return { path: safe.length ? safe : ["input"], exact: false };
    safe.push(String(part));
    candidates = next;
  }
  return { path: safe.length ? safe : ["input"], exact: path.length <= 20 };
}

function message(issue: Node): string {
  switch (issue.code) {
    case "invalid_type":
      return "Invalid value type";
    case "too_small":
      return issue.origin === "string"
        ? issue.minimum === 1
          ? "Must not be empty"
          : "Value is too short"
        : issue.origin === "array"
          ? "Too few items"
          : "Value is too small";
    case "too_big":
      return issue.origin === "string"
        ? "Value is too long"
        : issue.origin === "array"
          ? "Too many items"
          : "Value is too large";
    case "invalid_format":
      return "Invalid format";
    case "unrecognized_keys":
      return "Contains unexpected fields";
    default:
      return "Invalid value";
  }
}

/** Compile safe paths once. Neither raw Zod messages nor submitted values escape. */
export function inputErrorDetails(
  schema: object,
): (error: unknown) => readonly DatabaseErrorDetail[] {
  let root: Node | undefined;
  try {
    if (isSchema(schema)) {
      const converted: unknown = z.toJSONSchema(schema, {
        io: "input",
        unrepresentable: "any",
        metadata: z.registry(),
      });
      if (node(converted)) root = converted;
    }
  } catch {
    // A runtime-only schema still gets a safe root-level diagnostic.
  }
  return (error) => {
    const issues =
      node(error) && Array.isArray(error.issues) ? error.issues : [];
    const details: DatabaseErrorDetail[] = [];
    const seen = new Set<string>();
    for (const issue of issues.slice(0, 20)) {
      if (!node(issue)) continue;
      const safe = declaredPath(root, issue.path);
      const detail = {
        path: safe.path,
        message: safe.exact ? message(issue) : "Invalid value",
      };
      const key = JSON.stringify(detail);
      if (!seen.has(key)) {
        seen.add(key);
        details.push(detail);
      }
    }
    return details.length
      ? details
      : [{ path: ["input"], message: "Invalid value" }];
  };
}
