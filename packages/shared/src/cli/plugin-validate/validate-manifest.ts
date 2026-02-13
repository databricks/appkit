import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv, { type ErrorObject } from "ajv";
import addFormats from "ajv-formats";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(
  __dirname,
  "..",
  "..",
  "schemas",
  "plugin-manifest.schema.json",
);

export interface PluginManifestForValidate {
  name: string;
  displayName: string;
  description: string;
  resources: {
    required: unknown[];
    optional: unknown[];
  };
  config?: { schema: unknown };
}

export interface ValidateResult {
  valid: boolean;
  manifest?: PluginManifestForValidate;
  errors?: ErrorObject[];
}

let compiledValidator: ReturnType<Ajv["compile"]> | null = null;

function getValidator(): ReturnType<Ajv["compile"]> | null {
  if (compiledValidator) return compiledValidator;
  try {
    const schemaRaw = fs.readFileSync(SCHEMA_PATH, "utf-8");
    const schema = JSON.parse(schemaRaw) as object;
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    compiledValidator = ajv.compile(schema);
    return compiledValidator;
  } catch {
    return null;
  }
}

/**
 * Validate a manifest object against the plugin-manifest JSON schema.
 * Returns validation result with optional errors for CLI output.
 */
export function validateManifest(
  obj: unknown,
  _sourcePath: string,
): ValidateResult {
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

  const validate = getValidator();
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
    if (basicValid)
      return { valid: true, manifest: obj as PluginManifestForValidate };
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
  if (valid) return { valid: true, manifest: obj as PluginManifestForValidate };
  return { valid: false, errors: validate.errors ?? [] };
}

/**
 * Format schema errors for CLI output.
 */
export function formatValidationErrors(errors: ErrorObject[]): string {
  return errors
    .map(
      (e) =>
        `  ${e.instancePath || "/"} ${e.message}${e.params ? ` (${JSON.stringify(e.params)})` : ""}`,
    )
    .join("\n");
}
