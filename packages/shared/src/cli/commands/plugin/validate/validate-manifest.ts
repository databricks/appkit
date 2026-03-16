import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv, { type ErrorObject } from "ajv";
import addFormats from "ajv-formats";
import type { PluginManifest, TemplatePlugin } from "../manifest-types";

export type { PluginManifest };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = path.join(__dirname, "..", "..", "..", "..", "schemas");
const PLUGIN_MANIFEST_SCHEMA_PATH = path.join(
  SCHEMAS_DIR,
  "plugin-manifest.schema.json",
);
const TEMPLATE_PLUGINS_SCHEMA_PATH = path.join(
  SCHEMAS_DIR,
  "template-plugins.schema.json",
);

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

export interface ValidateResult {
  valid: boolean;
  manifest?: PluginManifest;
  errors?: ErrorObject[];
}

let schemaLoadWarned = false;

function loadSchema(schemaPath: string): object | null {
  try {
    return JSON.parse(fs.readFileSync(schemaPath, "utf-8")) as object;
  } catch (err) {
    if (!schemaLoadWarned) {
      schemaLoadWarned = true;
      console.warn(
        `Warning: Could not load JSON schema at ${schemaPath}: ${err instanceof Error ? err.message : err}. Falling back to basic validation.`,
      );
    }
    return null;
  }
}

let compiledPluginValidator: ReturnType<Ajv["compile"]> | null = null;

function getPluginValidator(): ReturnType<Ajv["compile"]> | null {
  if (compiledPluginValidator) return compiledPluginValidator;
  const schema = loadSchema(PLUGIN_MANIFEST_SCHEMA_PATH);
  if (!schema) return null;
  try {
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    compiledPluginValidator = ajv.compile(schema);
    return compiledPluginValidator;
  } catch {
    return null;
  }
}

let compiledTemplateValidator: ReturnType<Ajv["compile"]> | null = null;

interface PluginLike {
  name: string;
  resources: PluginManifest["resources"];
  postScaffold?: PluginManifest["postScaffold"];
}

function createSemanticError(
  instancePath: string,
  message: string,
): ErrorObject {
  return {
    keyword: "custom",
    instancePath,
    schemaPath: "#/semantic",
    params: {},
    message,
  } as ErrorObject;
}

function collectDiscoveryErrors(
  fields: Record<string, { discovery?: { dependsOn?: string } }>,
  fieldBasePath: string,
): ErrorObject[] {
  const errors: ErrorObject[] = [];
  const fieldNames = new Set(Object.keys(fields));

  for (const [fieldName, field] of Object.entries(fields)) {
    const dependsOn = field.discovery?.dependsOn;
    if (dependsOn && !fieldNames.has(dependsOn)) {
      errors.push(
        createSemanticError(
          `${fieldBasePath}/${fieldName}/discovery/dependsOn`,
          `dependsOn must reference another field in the same resource (got "${dependsOn}")`,
        ),
      );
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const cycleFields = new Set<string>();

  const visit = (fieldName: string) => {
    if (visited.has(fieldName)) return;
    if (visiting.has(fieldName)) {
      const cycleStart = stack.indexOf(fieldName);
      for (const name of stack.slice(cycleStart)) {
        cycleFields.add(name);
      }
      cycleFields.add(fieldName);
      return;
    }

    visiting.add(fieldName);
    stack.push(fieldName);

    const dependsOn = fields[fieldName]?.discovery?.dependsOn;
    if (dependsOn && fieldNames.has(dependsOn)) {
      visit(dependsOn);
    }

    stack.pop();
    visiting.delete(fieldName);
    visited.add(fieldName);
  };

  for (const fieldName of fieldNames) {
    if (fields[fieldName]?.discovery?.dependsOn) {
      visit(fieldName);
    }
  }

  for (const fieldName of cycleFields) {
    errors.push(
      createSemanticError(
        `${fieldBasePath}/${fieldName}/discovery/dependsOn`,
        "dependsOn chains must be acyclic",
      ),
    );
  }

  return errors;
}

function collectPostScaffoldErrors(
  steps: PluginLike["postScaffold"],
  basePath: string,
): ErrorObject[] {
  if (!steps) return [];

  const errors: ErrorObject[] = [];
  const seen = new Set<number>();
  let previousStep = 0;

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const stepPath = `${basePath}/postScaffold/${index}/step`;

    if (seen.has(step.step)) {
      errors.push(
        createSemanticError(
          stepPath,
          "postScaffold step numbers must be unique",
        ),
      );
    }

    if (step.step <= previousStep) {
      errors.push(
        createSemanticError(
          stepPath,
          "postScaffold step numbers must be strictly increasing",
        ),
      );
    }

    seen.add(step.step);
    previousStep = step.step;
  }

  return errors;
}

function collectPluginSemanticErrors(
  plugin: PluginLike,
  basePath: string,
): ErrorObject[] {
  const errors: ErrorObject[] = [];

  const buckets = [
    ["required", plugin.resources.required],
    ["optional", plugin.resources.optional],
  ] as const;

  for (const [bucketName, resources] of buckets) {
    resources.forEach((resource, resourceIndex) => {
      errors.push(
        ...collectDiscoveryErrors(
          resource.fields ?? {},
          `${basePath}/resources/${bucketName}/${resourceIndex}/fields`,
        ),
      );
    });
  }

  errors.push(...collectPostScaffoldErrors(plugin.postScaffold, basePath));

  return errors;
}

function getTemplateValidator(): ReturnType<Ajv["compile"]> | null {
  if (compiledTemplateValidator) return compiledTemplateValidator;
  const pluginSchema = loadSchema(PLUGIN_MANIFEST_SCHEMA_PATH);
  const templateSchema = loadSchema(TEMPLATE_PLUGINS_SCHEMA_PATH);
  if (!pluginSchema || !templateSchema) return null;
  try {
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    ajv.addSchema(pluginSchema);
    compiledTemplateValidator = ajv.compile(templateSchema);
    return compiledTemplateValidator;
  } catch {
    return null;
  }
}

/**
 * Validate a manifest object against the plugin-manifest JSON schema.
 * Returns validation result with optional errors for CLI output.
 */
export function validateManifest(obj: unknown): ValidateResult {
  if (!obj || typeof obj !== "object") {
    return {
      valid: false,
      errors: [
        {
          instancePath: "",
          message: "Manifest is not a valid object",
        } as ErrorObject,
      ],
    };
  }

  const validate = getPluginValidator();
  if (!validate) {
    const m = obj as Record<string, unknown>;
    const basicValid =
      typeof m.name === "string" &&
      m.name.length > 0 &&
      typeof m.displayName === "string" &&
      m.displayName.length > 0 &&
      typeof m.description === "string" &&
      m.description.length > 0 &&
      m.resources &&
      typeof m.resources === "object" &&
      Array.isArray((m.resources as { required?: unknown }).required);
    if (basicValid) return { valid: true, manifest: obj as PluginManifest };
    return {
      valid: false,
      errors: [
        {
          instancePath: "",
          message: "Invalid manifest structure",
        } as ErrorObject,
      ],
    };
  }

  const valid = validate(obj);
  if (valid) {
    const semanticErrors = collectPluginSemanticErrors(
      obj as PluginManifest,
      "",
    );
    if (semanticErrors.length > 0) {
      return { valid: false, errors: semanticErrors };
    }
    return { valid: true, manifest: obj as PluginManifest };
  }
  return { valid: false, errors: validate.errors ?? [] };
}

/**
 * Validate a template-plugins manifest (appkit.plugins.json) against its schema.
 * Registers the plugin-manifest schema first so external $refs resolve.
 */
export function validateTemplateManifest(obj: unknown): ValidateResult {
  if (!obj || typeof obj !== "object") {
    return {
      valid: false,
      errors: [
        {
          instancePath: "",
          message: "Template manifest is not a valid object",
        } as ErrorObject,
      ],
    };
  }

  const validate = getTemplateValidator();
  if (!validate) {
    const m = obj as Record<string, unknown>;
    const basicValid =
      typeof m.version === "string" &&
      m.plugins &&
      typeof m.plugins === "object";
    if (basicValid) return { valid: true };
    return {
      valid: false,
      errors: [
        {
          instancePath: "",
          message: "Invalid template manifest structure",
        } as ErrorObject,
      ],
    };
  }

  const valid = validate(obj);
  if (valid) {
    const templateManifest = obj as {
      plugins: Record<string, TemplatePlugin>;
    };
    const semanticErrors = Object.entries(templateManifest.plugins).flatMap(
      ([pluginName, plugin]) =>
        collectPluginSemanticErrors(plugin, `/plugins/${pluginName}`),
    );
    if (semanticErrors.length > 0) {
      return { valid: false, errors: semanticErrors };
    }
    return { valid: true };
  }
  return { valid: false, errors: validate.errors ?? [] };
}

/**
 * Convert a JSON pointer like /resources/required/0/permission
 * to a readable path like resources.required[0].permission
 */
function humanizePath(instancePath: string): string {
  if (!instancePath) return "(root)";
  return instancePath
    .replace(/^\//, "")
    .replace(/\/(\d+)\//g, "[$1].")
    .replace(/\/(\d+)$/g, "[$1]")
    .replace(/\//g, ".");
}

/**
 * Resolve a JSON pointer to the actual value in the parsed object.
 */
function resolvePointer(obj: unknown, instancePath: string): unknown {
  if (!instancePath) return obj;
  const segments = instancePath.replace(/^\//, "").split("/");
  let current: unknown = obj;
  for (const seg of segments) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[seg];
  }
  return current;
}

/**
 * Format schema errors for CLI output.
 * Collapses anyOf/oneOf sub-errors into a single message and shows
 * the actual invalid value when available.
 *
 * @param errors - AJV error objects
 * @param obj - The original parsed object (optional, used to show actual values)
 */
export function formatValidationErrors(
  errors: ErrorObject[],
  obj?: unknown,
): string {
  const grouped = new Map<string, ErrorObject[]>();
  for (const e of errors) {
    const key = e.instancePath || "/";
    if (!grouped.has(key)) grouped.set(key, []);
    const list = grouped.get(key);
    if (list) list.push(e);
  }

  const lines: string[] = [];

  for (const [path, errs] of grouped) {
    const readable = humanizePath(path);
    const anyOfErr = errs.find(
      (e) => e.keyword === "anyOf" || e.keyword === "oneOf",
    );

    if (anyOfErr) {
      const enumErrors = errs.filter((e) => e.keyword === "enum");
      if (enumErrors.length > 0) {
        const allValues = [
          ...new Set(
            enumErrors.flatMap(
              (e) => (e.params?.allowedValues as string[]) ?? [],
            ),
          ),
        ];
        const actual =
          obj !== undefined ? resolvePointer(obj, path) : undefined;
        const valueHint =
          actual !== undefined ? ` (got ${JSON.stringify(actual)})` : "";
        lines.push(
          `  ${readable}: invalid value${valueHint}`,
          `    allowed: ${allValues.join(", ")}`,
        );
        continue;
      }
    }

    for (const e of errs) {
      if (e.keyword === "anyOf" || e.keyword === "oneOf") continue;
      if (e.keyword === "if") continue;
      if (anyOfErr && e.keyword === "enum") continue;

      if (e.keyword === "enum") {
        const allowed = (e.params?.allowedValues as string[]) ?? [];
        const actual =
          obj !== undefined ? resolvePointer(obj, path) : undefined;
        const valueHint =
          actual !== undefined ? ` (got ${JSON.stringify(actual)})` : "";
        lines.push(
          `  ${readable}: invalid value${valueHint}, allowed: ${allowed.join(", ")}`,
        );
      } else if (e.keyword === "required") {
        lines.push(
          `  ${readable}: missing required property "${e.params?.missingProperty}"`,
        );
      } else if (e.keyword === "additionalProperties") {
        lines.push(
          `  ${readable}: unknown property "${e.params?.additionalProperty}"`,
        );
      } else if (e.keyword === "pattern") {
        const actual =
          obj !== undefined ? resolvePointer(obj, path) : undefined;
        const valueHint =
          actual !== undefined ? ` (got ${JSON.stringify(actual)})` : "";
        lines.push(
          `  ${readable}: does not match expected pattern${valueHint}`,
        );
      } else if (e.keyword === "type") {
        lines.push(`  ${readable}: expected type "${e.params?.type}"`);
      } else if (e.keyword === "minLength") {
        lines.push(`  ${readable}: must not be empty`);
      } else if (e.keyword === "custom") {
        lines.push(`  ${readable}: ${e.message}`);
      } else {
        lines.push(
          `  ${readable}: ${e.message}${e.params ? ` (${JSON.stringify(e.params)})` : ""}`,
        );
      }
    }
  }

  return lines.join("\n");
}
