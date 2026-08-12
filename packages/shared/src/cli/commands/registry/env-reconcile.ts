import {
  fieldOrigin,
  isValidEnvName,
  type RequirementField,
  type ResourceRequirementRow,
} from "./requirements";

/**
 * A single env var that an installed plugin needs in the local `.env`.
 * `platform`-origin fields are excluded upstream — they are injected by
 * Databricks Apps at deploy time and never belong in a hand-managed `.env`.
 */
export interface EnvNeed {
  env: string;
  resourceType: string;
  required: boolean;
  /** static-origin default value, pre-filled without prompting. */
  defaultValue?: string;
  origin?: string;
  description?: string;
}

/** The resolved decision for one env var after reconciliation. */
export interface EnvResolution {
  env: string;
  /** The value to write, or undefined when skipped / left unset. */
  value?: string;
  status: "written" | "already-set" | "skipped";
}

/**
 * A `.env` value is a single line: `KEY=VALUE`. A value carrying a CR/LF would
 * write extra lines when serialized, so a malicious static default like
 * `value: "y\nDATABRICKS_HOST=attacker"` could inject an unrelated key (host
 * override → credential exfil). Registry manifests are untrusted, so any value
 * with a line break is rejected rather than written.
 */
export function isSafeEnvValue(value: string): boolean {
  return !/[\r\n]/.test(value);
}

/**
 * Flattens requirement rows into the env vars that belong in local `.env`.
 * Excludes fields with no `env` name and `platform`-origin fields (deploy-time
 * platform injection). Order: required resources first (as given), then optional.
 */
export function collectEnvNeeds(rows: ResourceRequirementRow[]): EnvNeed[] {
  const needs: EnvNeed[] = [];
  const seen = new Set<string>();
  const ordered = [
    ...rows.filter((r) => r.required),
    ...rows.filter((r) => !r.required),
  ];
  for (const row of ordered) {
    for (const field of row.fields) {
      if (!includeInEnv(field)) continue;
      const env = field.env as string;
      if (seen.has(env)) continue;
      seen.add(env);
      needs.push({
        env,
        resourceType: row.type,
        required: row.required,
        defaultValue: field.value,
        origin: fieldOrigin(field),
        description: field.description,
      });
    }
  }
  return needs;
}

/** A field belongs in `.env` iff it names a valid env var and isn't platform-injected. */
function includeInEnv(field: RequirementField): boolean {
  if (!field.env) return false;
  // The env name comes from an untrusted manifest and is written as `NAME=value`;
  // a malformed name (e.g. one containing a newline) could inject an extra .env
  // line, so drop anything that isn't a plain env identifier.
  if (!isValidEnvName(field.env)) return false;
  // Origin is derived from the authored contract (localOnly/value/resolve) so
  // registry-fetched manifests without a computed origin classify correctly.
  return fieldOrigin(field) !== "platform";
}

/** Parses a `.env` file body into a KEY -> value map. Minimal KEY=VALUE scan. */
export function parseEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Serializes new env entries for appending to a `.env` file. Only keys not
 * already present are emitted; existing keys are never rewritten (we don't
 * clobber user edits). Returns the text to append (empty if nothing new).
 */
export function serializeEnvAppend(
  entries: Array<{ env: string; value: string; comment?: string }>,
): string {
  if (entries.length === 0) return "";
  const lines: string[] = [];
  for (const e of entries) {
    if (e.comment) lines.push(`# ${e.comment}`);
    lines.push(`${e.env}=${e.value}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Provides a value for an env need, or undefined to skip it. */
export type ValueProvider = (need: EnvNeed) => Promise<string | undefined>;

export interface ReconcileOptions {
  /** Existing parsed `.env` values (keys already present are left untouched). */
  existing: Record<string, string>;
  /** Resolves a value for each unset need (prompt in interactive, flag in CI). */
  provide: ValueProvider;
}

/**
 * Reconciles the needed env vars against what's already in `.env`.
 * - Already-set keys are reported as "already-set" and never overwritten.
 * - static-origin defaults are used without invoking `provide`.
 * - Everything else defers to `provide`; a returned undefined means skip.
 */
export async function reconcileEnv(
  needs: EnvNeed[],
  opts: ReconcileOptions,
): Promise<EnvResolution[]> {
  const resolutions: EnvResolution[] = [];
  for (const need of needs) {
    const current = opts.existing[need.env];
    if (current !== undefined && current !== "") {
      // Carry the existing value so callers can still feed it into deploy
      // config (databricks.yml target variables) — the var is set in .env but
      // its bundle binding still needs the value assigned.
      resolutions.push({
        env: need.env,
        value: current,
        status: "already-set",
      });
      continue;
    }
    if (need.defaultValue !== undefined) {
      // Static default from an untrusted manifest — refuse a value that would
      // inject extra `.env` lines rather than silently writing it.
      if (!isSafeEnvValue(need.defaultValue)) {
        resolutions.push({ env: need.env, status: "skipped" });
        continue;
      }
      resolutions.push({
        env: need.env,
        value: need.defaultValue,
        status: "written",
      });
      continue;
    }
    const value = await opts.provide(need);
    if (value === undefined || value === "" || !isSafeEnvValue(value)) {
      resolutions.push({ env: need.env, status: "skipped" });
    } else {
      resolutions.push({ env: need.env, value, status: "written" });
    }
  }
  return resolutions;
}
