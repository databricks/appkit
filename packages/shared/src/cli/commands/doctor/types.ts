/** Type definitions for the `appkit doctor` command. */

/** Layers run per resource, in order; a hard failure short-circuits the rest. */
export type CheckLayer = "auth" | "config" | "existence";

export type CheckStatus = "ok" | "warn" | "error" | "skipped";

/**
 * The existence-layer `code` marking a probe skipped because auth failed. Set in
 * `run.ts` and matched in `report.ts` to collapse those resources into one line;
 * shared so the two sides can't drift.
 */
export const AUTH_UNAVAILABLE_CODE = "AUTH_UNAVAILABLE";

/**
 * Severity ranking for a status. Used both to roll up the worst status across
 * layers and to sort report rows most-severe-first (descending severity).
 */
export const STATUS_SEVERITY: Record<CheckStatus, number> = {
  ok: 0,
  skipped: 1,
  warn: 2,
  error: 3,
};

/**
 * Where a resource's value comes from: `external` (exists now, so probe it) or
 * `bundle-managed` (created by this bundle on deploy, so not probed).
 * Undefined ⇒ external.
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
  /** Full underlying error, shown only with `--detail` or in `--json`. */
  raw?: string;
}

/** A finding from the offline three-file wiring check. */
export interface WiringFinding {
  status: CheckStatus;
  /** Machine-readable code (e.g. `VALUEFROM_UNBOUND`, `BUNDLE_REF_MISSING`). */
  code: string;
  /** The env var or binding at fault. */
  label: string;
  detail: string;
  hint?: string;
}

export interface DoctorReport {
  auth: AuthCheckResult;
  resources: ResourceCheckResult[];
  wiring: WiringFinding[];
  summary: { ok: number; warn: number; error: number; skipped: number };
}

export interface DoctorOptions {
  profile?: string;
  json?: boolean;
  /** Show full underlying error messages in the human report. */
  detail?: boolean;
  /** Env file to load before checking (e.g. `.env.local`); overrides the .env
   * the CLI auto-loads at startup. */
  envFile?: string;
}
