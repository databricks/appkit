import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv, { type ErrorObject } from "ajv";
import addFormats from "ajv-formats";
import type { MetricSourceConfiguration } from "../../../../schemas/metric-source.generated";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the metric-source schema path. The schema is copied to `dist/schemas`
 * by tsdown at build time so the published CLI can locate it; in dev (running
 * from `src/`) we walk back to the `src/schemas` checkout.
 */
const SCHEMAS_DIR = path.join(__dirname, "..", "..", "..", "..", "schemas");
const METRIC_SOURCE_SCHEMA_PATH = path.join(
  SCHEMAS_DIR,
  "metric-source.schema.json",
);

export interface ValidateMetricSourceResult {
  valid: boolean;
  config?: MetricSourceConfiguration;
  errors?: ErrorObject[];
}

let compiledValidator: ReturnType<Ajv["compile"]> | null = null;
let schemaLoadWarned = false;

function loadSchema(schemaPath: string): object | null {
  try {
    return JSON.parse(fs.readFileSync(schemaPath, "utf-8")) as object;
  } catch (err) {
    if (!schemaLoadWarned) {
      schemaLoadWarned = true;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `Warning: Could not load metric-source schema at ${schemaPath}: ${msg}. Falling back to basic validation.`,
      );
    }
    return null;
  }
}

function getValidator(): ReturnType<Ajv["compile"]> | null {
  if (compiledValidator) return compiledValidator;
  const schema = loadSchema(METRIC_SOURCE_SCHEMA_PATH);
  if (!schema) return null;
  try {
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    compiledValidator = ajv.compile(schema);
    return compiledValidator;
  } catch {
    return null;
  }
}

/**
 * Validate a parsed metric.json object against the metric-source JSON Schema.
 *
 * The schema is the canonical contract — any malformed input is rejected at the
 * CLI seam before we hand off to `syncMetrics()`. This mirrors the plugin
 * `validate-manifest` pattern: when the schema cannot be loaded (e.g. dist not
 * built yet) we fall back to a structural check so the CLI is still usable in
 * mid-build situations, but the full schema is the source of truth.
 */
export function validateMetricSource(obj: unknown): ValidateMetricSourceResult {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return {
      valid: false,
      errors: [
        {
          instancePath: "",
          message: "Metric source is not a valid object",
        } as ErrorObject,
      ],
    };
  }

  const validate = getValidator();
  if (!validate) {
    // Defensive fallback when the schema can't be loaded — accept any object
    // that has the rough sp/obo shape so the CLI does not hard-fail in a
    // partially-built tree. The dedicated schema test exercises the strict
    // path; this branch only fires in development edge cases.
    const m = obj as Record<string, unknown>;
    const spOk =
      m.sp == null || (typeof m.sp === "object" && !Array.isArray(m.sp));
    const oboOk =
      m.obo == null || (typeof m.obo === "object" && !Array.isArray(m.obo));
    if (spOk && oboOk) {
      return { valid: true, config: obj as MetricSourceConfiguration };
    }
    return {
      valid: false,
      errors: [
        {
          instancePath: "",
          message: "Invalid metric.json structure",
        } as ErrorObject,
      ],
    };
  }

  const valid = validate(obj);
  if (valid) return { valid: true, config: obj as MetricSourceConfiguration };
  return { valid: false, errors: validate.errors ?? [] };
}

/**
 * Convert a JSON pointer like /sp/revenue/source to a readable path
 * like sp.revenue.source for CLI output.
 */
function humanizePath(instancePath: string): string {
  if (!instancePath) return "(root)";
  return instancePath.replace(/^\//, "").replace(/\//g, ".");
}

/**
 * Format AJV errors for CLI output.
 *
 * The output is a multi-line block (one issue per line, two-space indent) so
 * it can be embedded directly under a "Invalid metric.json:" header by the
 * caller. Mirrors the plugin manifest validator's formatter shape so the CLI
 * UX stays consistent across `plugin validate` and `metric sync`.
 */
export function formatMetricSourceErrors(errors: ErrorObject[]): string {
  const lines: string[] = [];
  for (const err of errors) {
    const readable = humanizePath(err.instancePath);
    if (err.keyword === "required") {
      lines.push(
        `  ${readable}: missing required property "${err.params?.missingProperty}"`,
      );
    } else if (err.keyword === "additionalProperties") {
      lines.push(
        `  ${readable}: unknown property "${err.params?.additionalProperty}"`,
      );
    } else if (err.keyword === "pattern") {
      lines.push(
        `  ${readable}: does not match expected pattern${err.message ? ` (${err.message})` : ""}`,
      );
    } else if (err.keyword === "type") {
      lines.push(`  ${readable}: expected type "${err.params?.type}"`);
    } else {
      lines.push(`  ${readable}: ${err.message ?? "validation error"}`);
    }
  }
  return lines.join("\n");
}
