/**
 * Resource types and permissions derived from plugin-manifest.schema.json.
 * Single source of truth so create, add-resource, and validate stay in sync with the schema.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_NAME = "plugin-manifest.schema.json";
// Try dist/schemas first (shared build + appkit pack), then dist/cli/schemas
const SCHEMA_PATHS = [
  path.join(__dirname, "..", "..", "..", "schemas", SCHEMA_NAME),
  path.join(__dirname, "..", "..", "schemas", SCHEMA_NAME),
];

export interface ResourceTypeOption {
  value: string;
  label: string;
}

function loadSchema(): Record<string, unknown> | null {
  for (const schemaPath of SCHEMA_PATHS) {
    try {
      if (fs.existsSync(schemaPath)) {
        return JSON.parse(fs.readFileSync(schemaPath, "utf-8")) as Record<
          string,
          unknown
        >;
      }
    } catch {
      // try next path
    }
  }
  return null;
}

/** Optional display overrides for acronyms (e.g. SQL, UC). Omitted entries use title-case of value. */
const LABEL_OVERRIDES: Record<string, string> = {
  sql_warehouse: "SQL Warehouse",
  uc_function: "UC Function",
  uc_connection: "UC Connection",
};

function humanize(value: string): string {
  if (LABEL_OVERRIDES[value]) return LABEL_OVERRIDES[value];
  return value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

let cachedOptions: ResourceTypeOption[] | null = null;
let cachedPermissions: Record<string, string[]> | null = null;

/**
 * Resource type options (value + label) from schema $defs.resourceType.enum.
 */
export function getResourceTypeOptions(): ResourceTypeOption[] {
  if (cachedOptions) return cachedOptions;
  const schema = loadSchema();
  const defs = schema?.$defs as Record<string, unknown> | undefined;
  const resourceType = defs?.resourceType as { enum?: string[] } | undefined;
  const enumArr = resourceType?.enum;
  if (!Array.isArray(enumArr)) {
    cachedOptions = [];
    return cachedOptions;
  }
  cachedOptions = enumArr.map((value) => ({
    value,
    label: humanize(value),
  }));
  return cachedOptions;
}

/**
 * Permissions per resource type from schema resourceRequirement.allOf (if/then).
 */
export function getResourceTypePermissions(): Record<string, string[]> {
  if (cachedPermissions) return cachedPermissions;
  const schema = loadSchema();
  const out: Record<string, string[]> = {};
  if (!schema?.$defs || typeof schema.$defs !== "object") {
    cachedPermissions = out;
    return out;
  }
  const defs = schema.$defs as Record<string, unknown>;
  const resourceReq = defs.resourceRequirement as
    | Record<string, unknown>
    | undefined;
  const allOf = resourceReq?.allOf as
    | Array<{
        if?: { properties?: { type?: { const?: string } } };
        then?: { properties?: { permission?: { $ref?: string } } };
      }>
    | undefined;
  if (!Array.isArray(allOf)) {
    cachedPermissions = out;
    return out;
  }
  for (const branch of allOf) {
    const typeConst = branch?.if?.properties?.type?.const;
    const ref = branch?.then?.properties?.permission?.$ref;
    if (typeof typeConst !== "string" || typeof ref !== "string") continue;
    const refSegments = ref.replace(/^#\//, "").split("/");
    let def: unknown = schema;
    for (const seg of refSegments) {
      if (def == null || typeof def !== "object") break;
      def = (def as Record<string, unknown>)[seg];
    }
    const enumArr = Array.isArray((def as { enum?: string[] })?.enum)
      ? (def as { enum: string[] }).enum
      : undefined;
    if (enumArr?.length) out[typeConst] = enumArr;
  }
  cachedPermissions = out;
  return out;
}
