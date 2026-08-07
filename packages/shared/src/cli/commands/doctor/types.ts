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
 * The existence-layer `code` marking a resource created by this bundle on
 * deploy. Set in `run.ts` and matched in `report.ts` to keep the expected skip
 * quiet; shared so the two sides can't drift.
 */
export const BUNDLE_MANAGED_CODE = "BUNDLE_MANAGED";

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

/**
 * A finding about doctor's own inputs rather than a resource — e.g. no `.env`
 * where one was expected. Shares {@link WiringFinding}'s shape so the report can
 * render both with one code path.
 */
export type SetupFinding = WiringFinding;

export interface DoctorReport {
  auth: AuthCheckResult;
  resources: ResourceCheckResult[];
  wiring: WiringFinding[];
  /** Findings about doctor's own inputs (e.g. a missing `.env`), which explain
   * an otherwise-empty or misleading report. */
  setup: SetupFinding[];
  /**
   * Authoritative counts across *everything* that has a status — resources,
   * the auth check, and wiring findings — not just resources. A `--json`
   * consumer can trust `summary.error === 0` to mean "nothing failed".
   */
  summary: { ok: number; warn: number; error: number; skipped: number };
  /** Process exit code (0 ok, 1 if anything errored). The single unambiguous
   * pass/fail signal for programmatic consumers. */
  exitCode: number;
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
