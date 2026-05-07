import type { StandardSchemaV1 } from "@standard-schema/spec";
import {
  pluginManifestSchema,
  templatePluginsManifestSchema,
} from "../../../../schemas/manifest";
import type { PluginManifest } from "../manifest-types";

export type { PluginManifest };

export type SchemaType = "plugin-manifest" | "template-plugins" | "unknown";

const SCHEMA_ID_MAP: Record<string, SchemaType> = {
  "https://databricks.github.io/appkit/schemas/plugin-manifest.schema.json":
    "plugin-manifest",
  "https://databricks.github.io/appkit/schemas/template-plugins.schema.json":
    "template-plugins",
};

/**
 * Detect which schema type a parsed JSON object targets based on its $schema field.
 * Returns "unknown" when the field is missing or unrecognized.
 */
export function detectSchemaType(obj: unknown): SchemaType {
  if (!obj || typeof obj !== "object") return "unknown";
  const schemaUrl = (obj as Record<string, unknown>).$schema;
  if (typeof schemaUrl !== "string") return "unknown";
  return SCHEMA_ID_MAP[schemaUrl] ?? "unknown";
}

/**
 * A single validation issue produced by the schema validator. The `path`
 * is a humanized property path (e.g., `resources.required[0].permission`)
 * suitable for direct CLI output.
 */
export interface SemanticIssue {
  level: "error" | "warning";
  path: string;
  message: string;
}

export interface ValidateResult {
  valid: boolean;
  manifest?: PluginManifest;
  errors?: SemanticIssue[];
}

/**
 * Convert a Standard Schema issue path (array of property keys / path segments)
 * into a humanized string like `resources.required[0].permission`.
 */
function humanizePath(
  path: ReadonlyArray<PropertyKey | StandardSchemaV1.PathSegment> | undefined,
): string {
  if (!path || path.length === 0) return "(root)";

  let out = "";
  for (const segment of path) {
    const key =
      typeof segment === "object" && segment !== null && "key" in segment
        ? segment.key
        : segment;
    if (typeof key === "number") {
      out += `[${key}]`;
    } else {
      const str = String(key);
      out += out.length === 0 ? str : `.${str}`;
    }
  }
  return out.length === 0 ? "(root)" : out;
}

/**
 * Map a Standard Schema issue list into the legacy `SemanticIssue` shape so
 * consumer code can stay uniform.
 */
function mapIssues(
  issues: ReadonlyArray<StandardSchemaV1.Issue>,
): SemanticIssue[] {
  const result: SemanticIssue[] = [];
  for (const issue of issues) {
    result.push({
      level: "error",
      path: humanizePath(issue.path),
      message: issue.message,
    });
  }
  return result;
}

/**
 * Validate an object against a Standard Schema and produce a uniform
 * `ValidateResult`. The manifest output is captured for downstream consumers.
 */
function validateWithStandardSchema<T>(
  schema: StandardSchemaV1<unknown, T>,
  obj: unknown,
): { valid: true; output: T } | { valid: false; errors: SemanticIssue[] } {
  const result = schema["~standard"].validate(obj);
  if (result instanceof Promise) {
    // Our schemas are synchronous; treat any async resolution as an error
    // rather than blocking the CLI on a background promise.
    return {
      valid: false,
      errors: [
        {
          level: "error",
          path: "(root)",
          message:
            "Schema returned an async validation result; expected synchronous validation.",
        },
      ],
    };
  }
  if (result.issues) {
    return { valid: false, errors: mapIssues(result.issues) };
  }
  return { valid: true, output: result.value };
}

/**
 * Validate a manifest object against the plugin-manifest schema.
 * Returns validation result with optional errors for CLI output.
 *
 * On success, the returned `manifest` is the original input object (preserving
 * its property order) typed as `PluginManifest`, not a re-emitted Zod copy.
 * Round-trip writers like `add-resource` rely on this to keep the on-disk
 * field ordering stable.
 */
export function validateManifest(obj: unknown): ValidateResult {
  if (!obj || typeof obj !== "object") {
    return {
      valid: false,
      errors: [
        {
          level: "error",
          path: "(root)",
          message: "Manifest is not a valid object",
        },
      ],
    };
  }

  const result = validateWithStandardSchema(pluginManifestSchema, obj);
  if (result.valid) {
    return { valid: true, manifest: obj as PluginManifest };
  }
  return { valid: false, errors: result.errors };
}

/**
 * Validate a template-plugins manifest (appkit.plugins.json) against its schema.
 */
export function validateTemplateManifest(obj: unknown): ValidateResult {
  if (!obj || typeof obj !== "object") {
    return {
      valid: false,
      errors: [
        {
          level: "error",
          path: "(root)",
          message: "Template manifest is not a valid object",
        },
      ],
    };
  }

  const result = validateWithStandardSchema(templatePluginsManifestSchema, obj);
  if (result.valid) {
    return { valid: true };
  }
  return { valid: false, errors: result.errors };
}

/**
 * Format validation issues for CLI output. Each issue is rendered on its own
 * line indented by two spaces, with the format `  <path>: <message>`. The
 * `path` is already humanized when issues are produced by `validateManifest`
 * / `validateTemplateManifest`.
 */
export function formatValidationErrors(issues: SemanticIssue[]): string {
  return issues.map((issue) => `  ${issue.path}: ${issue.message}`).join("\n");
}
