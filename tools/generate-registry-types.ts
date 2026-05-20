/**
 * Generates registry types (ResourceType enum, permission types, hierarchy) from
 * the canonical Zod schemas in `packages/shared/src/schemas/manifest.ts`. Single
 * source of truth for resource types and permissions.
 *
 * The resource-type enum + per-type permission enums are extracted via Zod 4's
 * native `.options` accessor on enum schemas (no runtime JSON-schema read).
 *
 * Run from repo root: pnpm exec tsx tools/generate-registry-types.ts
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appPermissionSchema,
  databasePermissionSchema,
  experimentPermissionSchema,
  genieSpacePermissionSchema,
  jobPermissionSchema,
  postgresPermissionSchema,
  resourceTypeSchema,
  secretPermissionSchema,
  servingEndpointPermissionSchema,
  sqlWarehousePermissionSchema,
  ucConnectionPermissionSchema,
  ucFunctionPermissionSchema,
  vectorSearchIndexPermissionSchema,
  volumePermissionSchema,
} from "../packages/shared/src/schemas/manifest";
import { formatWithBiome } from "./format-with-biome";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const OUT_PATH = path.join(
  REPO_ROOT,
  "packages/appkit/src/registry/types.generated.ts",
);

/** value "sql_warehouse" -> "SQL_WAREHOUSE" */
function toEnumKey(value: string): string {
  return value.toUpperCase().replace(/-/g, "_");
}

/** type "sql_warehouse" -> "SqlWarehousePermission" */
function toPermissionTypeName(type: string): string {
  return (
    type
      .split("_")
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join("") + "Permission"
  );
}

/**
 * Per-type permission enum schemas, keyed by the resource type literal.
 * Mirrors `schema-resources.ts`'s `PERMISSION_SCHEMAS_BY_TYPE`. Add an entry
 * when extending `resourceTypeSchema`.
 */
const PERMISSION_SCHEMAS_BY_TYPE = {
  secret: secretPermissionSchema,
  job: jobPermissionSchema,
  sql_warehouse: sqlWarehousePermissionSchema,
  serving_endpoint: servingEndpointPermissionSchema,
  volume: volumePermissionSchema,
  vector_search_index: vectorSearchIndexPermissionSchema,
  uc_function: ucFunctionPermissionSchema,
  uc_connection: ucConnectionPermissionSchema,
  database: databasePermissionSchema,
  postgres: postgresPermissionSchema,
  genie_space: genieSpacePermissionSchema,
  experiment: experimentPermissionSchema,
  app: appPermissionSchema,
} as const;

function generate(): string {
  const resourceTypes = [...resourceTypeSchema.options];

  const lines: string[] = [
    "// AUTO-GENERATED from packages/shared/src/schemas/manifest.ts (Zod canonical).",
    "// Do not edit. Run: pnpm exec tsx tools/generate-registry-types.ts",
    "",
    "/** Resource types from resourceTypeSchema.options */",
    "export enum ResourceType {",
    ...resourceTypes.map((v) => `  ${toEnumKey(v)} = "${v}",`),
    "}",
    "",
    "// ============================================================================",
    "// Permissions per resource type (from per-type permission enum schemas)",
    "// ============================================================================",
  ];

  const permissionTypeNames: string[] = [];
  const typeToPermissions: Record<string, string[]> = {};

  for (const type of resourceTypes) {
    const schema = PERMISSION_SCHEMAS_BY_TYPE[type];
    if (!schema) {
      throw new Error(
        `generate-registry-types: missing permission schema for resource type '${type}'. ` +
          `Add it to PERMISSION_SCHEMAS_BY_TYPE in tools/generate-registry-types.ts.`,
      );
    }
    const perms = [...schema.options];
    typeToPermissions[type] = perms;
    const typeName = toPermissionTypeName(type);
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
    `export type ResourcePermission =\n  | ${permissionTypeNames.join("\n  | ")};`,
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
  const out = generate();
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, out, "utf-8");
  formatWithBiome(OUT_PATH);
  console.log("Wrote", OUT_PATH);
}

main();
