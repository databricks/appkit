import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv, { type ErrorObject } from "ajv";
import addFormats from "ajv-formats";
import type {
  PluginManifest,
  TemplatePluginsManifest,
} from "../manifest-types";

export type { PluginManifest };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = path.join(__dirname, "..", "..", "..", "..", "schemas");
const PLUGIN_MANIFEST_SCHEMA_PATH = path.join(
  SCHEMAS_DIR,
  "plugin-manifest.schema.json",
);
const TEMPLATE_PLUGINS_V2_SCHEMA_PATH = path.join(
  SCHEMAS_DIR,
  "template-plugins.schema.v2.json",
);

export type SchemaType = "plugin-manifest" | "template-plugins" | "unknown";

const SCHEMA_ID_MAP: Record<string, SchemaType> = {
  "https://databricks.github.io/appkit/schemas/plugin-manifest.schema.json":
    "plugin-manifest",
  "https://databricks.github.io/appkit/schemas/template-plugins.schema.v2.json":
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

function makeSemanticError(
  instancePath: string,
  message: string,
  params: Record<string, unknown> = {},
): ErrorObject {
  return {
    keyword: "semantic",
    instancePath,
    schemaPath: "#/semantic",
    params,
    message,
  } as ErrorObject;
}

function validateResourceFields(
  fields: NonNullable<
    PluginManifest["resources"]["required"]
  >[number]["fields"],
  instancePath: string,
): ErrorObject[] {
  const errors: ErrorObject[] = [];
  const fieldNames = new Set(Object.keys(fields));
  const dependencyGraph = new Map<string, string>();

  for (const [fieldName, field] of Object.entries(fields)) {
    const discoveryPath = `${instancePath}/fields/${fieldName}/discovery`;
    const fieldPath = `${instancePath}/fields/${fieldName}`;

    if (
      field.resolution !== undefined &&
      !["user-provided", "platform-injected"].includes(field.resolution)
    ) {
      errors.push(
        makeSemanticError(
          `${fieldPath}/resolution`,
          'must be "user-provided" or "platform-injected"',
        ),
      );
    }

    if (!field.discovery) continue;

    if (!field.discovery.cliCommand.includes("--profile")) {
      errors.push(
        makeSemanticError(
          `${discoveryPath}/cliCommand`,
          "must include --profile in discovery CLI commands",
        ),
      );
    }

    if (
      field.discovery.shortcut &&
      !field.discovery.shortcut.includes("--profile")
    ) {
      errors.push(
        makeSemanticError(
          `${discoveryPath}/shortcut`,
          "must include --profile in discovery shortcut commands",
        ),
      );
    }

    if (field.discovery.dependsOn) {
      if (!fieldNames.has(field.discovery.dependsOn)) {
        errors.push(
          makeSemanticError(
            `${discoveryPath}/dependsOn`,
            "must reference another field in the same resource",
            { dependsOn: field.discovery.dependsOn },
          ),
        );
      } else {
        dependencyGraph.set(fieldName, field.discovery.dependsOn);
      }
    }
  }

  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(fieldName: string) {
    if (visiting.has(fieldName)) {
      errors.push(
        makeSemanticError(
          `${instancePath}/fields`,
          "discovery.dependsOn must not form a cycle",
        ),
      );
      return;
    }
    if (visited.has(fieldName)) return;

    visiting.add(fieldName);
    const dependency = dependencyGraph.get(fieldName);
    if (dependency) visit(dependency);
    visiting.delete(fieldName);
    visited.add(fieldName);
  }

  for (const fieldName of dependencyGraph.keys()) {
    visit(fieldName);
  }

  return errors;
}

function validatePostScaffold(
  postScaffold: PluginManifest["postScaffold"],
  instancePath: string,
): ErrorObject[] {
  if (!postScaffold || postScaffold.length === 0) return [];

  const steps = postScaffold.map((step) => step.step);
  const expected = Array.from(
    { length: steps.length },
    (_, index) => index + 1,
  );
  const isSequential =
    steps.length === expected.length &&
    steps.every((step, index) => step === expected[index]);

  if (isSequential) return [];

  return [
    makeSemanticError(
      `${instancePath}/postScaffold`,
      "postScaffold steps must be unique, ordered, and sequential starting at 1",
      { steps },
    ),
  ];
}

function validatePluginSemantics(
  plugin: Pick<PluginManifest, "resources" | "postScaffold">,
  instancePath: string,
): ErrorObject[] {
  const errors: ErrorObject[] = [];
  const required = plugin.resources?.required ?? [];
  const optional = plugin.resources?.optional ?? [];

  for (const [index, resource] of [...required, ...optional].entries()) {
    const resourcePath =
      index < required.length
        ? `${instancePath}/resources/required/${index}`
        : `${instancePath}/resources/optional/${index - required.length}`;
    errors.push(...validateResourceFields(resource.fields, resourcePath));
  }

  errors.push(...validatePostScaffold(plugin.postScaffold, instancePath));
  return errors;
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

function getTemplateValidator(): ReturnType<Ajv["compile"]> | null {
  if (compiledTemplateValidator) return compiledTemplateValidator;
  const pluginSchema = loadSchema(PLUGIN_MANIFEST_SCHEMA_PATH);
  const templateSchema = loadSchema(TEMPLATE_PLUGINS_V2_SCHEMA_PATH);
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
    const semanticErrors = validatePluginSemantics(obj as PluginManifest, "");
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
    const manifest = obj as TemplatePluginsManifest;
    const semanticErrors = Object.entries(manifest.plugins).flatMap(
      ([pluginName, plugin]) =>
        validatePluginSemantics(plugin, `/plugins/${pluginName}`),
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
      } else {
        lines.push(
          `  ${readable}: ${e.message}${e.params ? ` (${JSON.stringify(e.params)})` : ""}`,
        );
      }
    }
  }

  return lines.join("\n");
}
