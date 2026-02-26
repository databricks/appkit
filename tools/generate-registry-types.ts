/**
 * Generates registry types (ResourceType enum, permission types, hierarchy) from
 * plugin-manifest.schema.json. Single source of truth for resource types and permissions.
 *
 * Run from repo root: pnpm exec tsx tools/generate-registry-types.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const SCHEMA_PATH = path.join(
  REPO_ROOT,
  "packages/shared/src/schemas/plugin-manifest.schema.json",
);
const OUT_PATH = path.join(
  REPO_ROOT,
  "packages/appkit/src/registry/types.generated.ts",
);

interface SchemaDefs {
  resourceType?: { enum?: string[] };
  resourceRequirement?: {
    allOf?: Array<{
      if?: { properties?: { type?: { const?: string } } };
      then?: { properties?: { permission?: { $ref?: string } } };
    }>;
  };
  [key: string]: unknown;
}

function loadSchema(): Record<string, unknown> {
  const raw = fs.readFileSync(SCHEMA_PATH, "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

/** value "sql_warehouse" -> "SQL_WAREHOUSE" */
function toEnumKey(value: string): string {
  return value.toUpperCase().replace(/-/g, "_");
}

/** def key "secretPermission" -> "SecretPermission" */
function toPermissionTypeName(defKey: string): string {
  return defKey.charAt(0).toUpperCase() + defKey.slice(1);
}

function generate(schema: Record<string, unknown>): string {
  const defs = (schema.$defs ?? {}) as SchemaDefs;
  const resourceType = defs.resourceType;
  const resourceReq = defs.resourceRequirement;
  const allOf = resourceReq?.allOf ?? [];

  const resourceTypes: string[] = resourceType?.enum ?? [];
  const typeToPermissionRef: Array<{ type: string; ref: string }> = [];

  for (const branch of allOf) {
    const typeConst = branch?.if?.properties?.type?.const;
    const ref = branch?.then?.properties?.permission?.$ref;
    if (typeof typeConst === "string" && typeof ref === "string") {
      typeToPermissionRef.push({ type: typeConst, ref });
    }
  }

  // Resolve ref to def key: "#/$defs/secretPermission" -> "secretPermission"
  const refToDefKey = (ref: string): string => {
    const segments = ref.replace(/^#\//, "").split("/");
    return segments[segments.length - 1] ?? "";
  };

  const defKeyToPermissionTypeName: Record<string, string> = {};
  const typeToPermissions: Record<string, string[]> = {};

  for (const { type, ref } of typeToPermissionRef) {
    const defKey = refToDefKey(ref);
    const permDef = defs[defKey] as { enum?: string[] } | undefined;
    const enumArr = permDef?.enum ?? [];
    if (enumArr.length > 0) {
      defKeyToPermissionTypeName[defKey] = toPermissionTypeName(defKey);
      // Schema enum order is weakest to strongest (see schema descriptions)
      typeToPermissions[type] = [...enumArr];
    }
  }

  const lines: string[] = [
    "// AUTO-GENERATED from packages/shared/src/schemas/plugin-manifest.schema.json",
    "// Do not edit. Run: pnpm exec tsx tools/generate-registry-types.ts",
    "",
    "/** Resource types from schema $defs.resourceType.enum */",
    "export enum ResourceType {",
    ...resourceTypes.map((v) => `  ${toEnumKey(v)} = "${v}",`),
    "}",
    "",
    "// ============================================================================",
    "// Permissions per resource type (from schema permission $defs)",
    "// ============================================================================",
  ];

  const permissionTypeNames: string[] = [];
  for (const { type, ref } of typeToPermissionRef) {
    const defKey = refToDefKey(ref);
    const typeName = defKeyToPermissionTypeName[defKey];
    if (!typeName) continue;
    const perms = typeToPermissions[type];
    if (!perms?.length) continue;
    permissionTypeNames.push(typeName);
    const union = perms.map((p) => `"${p}"`).join(" | ");
    lines.push(`/** Permissions for ${toEnumKey(type)} resources */`);
    lines.push(`export type ${typeName} = ${union};`);
    lines.push("");
  }

  lines.push(
    "/** Union of all possible permission levels across all resource types. */",
  );
  lines.push(
    "export type ResourcePermission =\n  | " +
      permissionTypeNames.join("\n  | ") +
      ";",
  );
  lines.push("");
  lines.push(
    "/** Permission hierarchy per resource type (weakest to strongest). Schema enum order. */",
  );
  lines.push(
    "export const PERMISSION_HIERARCHY_BY_TYPE: Record<ResourceType, readonly ResourcePermission[]> = {",
  );
  for (const type of resourceTypes) {
    const perms = typeToPermissions[type];
    if (perms?.length) {
      lines.push(
        `  [ResourceType.${toEnumKey(type)}]: [${perms.map((p) => `"${p}"`).join(", ")}],`,
      );
    }
  }
  lines.push("} as const;");
  lines.push("");
  lines.push("/** Set of valid permissions per type (for validation). */");
  lines.push(
    "export const PERMISSIONS_BY_TYPE: Record<ResourceType, readonly ResourcePermission[]> = PERMISSION_HIERARCHY_BY_TYPE;",
  );
  lines.push("");

  return lines.join("\n");
}

function main(): void {
  const schema = loadSchema();
  const out = generate(schema);
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, out, "utf-8");
  console.log("Wrote", OUT_PATH);
}

main();
