/** Type definitions for the `appkit doctor` command. */

/** Layers run per resource, in order; a hard failure short-circuits the rest. */
export type CheckLayer = "auth" | "config" | "existence";

export type CheckStatus = "ok" | "warn" | "error" | "skipped";

/**
 * Where a resource's value comes from, per the bundle (`databricks.yml`):
 * - `external`      — an existing resource referenced by id/name (`${var.*}` or a
 *                     literal). It should exist now, so the live probe applies.
 * - `bundle-managed`— created by this same bundle (`${resources.<type>.<key>.*}`);
 *                     it doesn't exist until `bundle deploy`, so we validate the
 *                     declaration instead of probing.
 * Undefined ⇒ external (no bundle info, or an AppKit app with no databricks.yml).
 */
export type ResourceOrigin = "external" | "bundle-managed";

export interface LayerResult {
  layer: CheckLayer;
  status: CheckStatus;
  detail?: string;
  /** Inferred guidance for fixing the finding. */
  hint?: string;
  /** Machine-readable code for `--json` consumers (e.g. `NOT_FOUND`). */
  code?: string;
}

export interface ResourceTarget {
  type: string;
  resourceKey: string;
  /** Human-readable label. */
  alias: string;
  plugin: string;
  /** Declared permission level; shown for context, not checked. */
  requiredPermission: string;
  /** Mandatory (vs optional) for the app. */
  required: boolean;
  envVars: string[];
  /** Resolved field values keyed by manifest field name; unset fields omitted. */
  fieldValues: Record<string, string>;
  /** Provenance from the bundle; undefined ⇒ treated as external. */
  origin?: ResourceOrigin;
}

export interface ResourceCheckResult {
  target: ResourceTarget;
  /** Worst status across all layers run for this resource. */
  status: CheckStatus;
  layers: LayerResult[];
}

export interface AuthCheckResult {
  status: CheckStatus;
  detail?: string;
  hint?: string;
  code?: string;
  host?: string;
  profile?: string;
  /** Full underlying error (e.g. the raw SDK message). Shown only with
   * `--detail` or in `--json`; the human report relies on `detail` + `hint`. */
  raw?: string;
}

/**
 * A finding from the offline three-file wiring check (Phase 2): does each
 * `app.yaml` `valueFrom` bind to a real databricks.yml binding, and does each
 * bundle-managed `${resources.*}` reference resolve to a declared bundle
 * resource. Independent of auth — it's a deploy-declaration check, not a live one.
 */
export interface WiringFinding {
  status: CheckStatus;
  /** Machine-readable code (e.g. `VALUEFROM_UNBOUND`, `BUNDLE_REF_MISSING`). */
  code: string;
  /** Short row label (the env var or binding at fault), so a wiring row renders
   * with the same shape as a resource row: `glyph  label` then indented detail. */
  label: string;
  detail: string;
  hint?: string;
}

export interface DoctorReport {
  auth: AuthCheckResult;
  /** Live connectivity checks for external resources. */
  resources: ResourceCheckResult[];
  /** Deploy-declaration findings: bundle-managed resources + wiring consistency. */
  wiring: WiringFinding[];
  summary: { ok: number; warn: number; error: number; skipped: number };
}

export interface DoctorOptions {
  /** Path to the resolved template manifest (defaults to appkit.plugins.json). */
  manifest?: string;
  profile?: string;
  json?: boolean;
  /** Show full underlying error messages (raw SDK output) in the human report. */
  detail?: boolean;
  /**
   * Path to an env file to load before checking (e.g. `.env.local`). Its values
   * override the `.env` the CLI auto-loads at startup, so doctor checks the same
   * environment the app runs with.
   */
  envFile?: string;
}
