import fs from "node:fs";
import path from "node:path";

import { autocomplete, isCancel, select, text } from "@clack/prompts";
import pc from "picocolors";

import type { BindingValueNeed } from "./config-plan";
import {
  collectEnvNeeds,
  type EnvNeed,
  type EnvResolution,
  parseEnv,
  reconcileEnv,
  serializeEnvAppend,
  type ValueProvider,
} from "./env-reconcile";
import type { ResourceRequirementRow } from "./requirements";
import {
  composeResourceId,
  isFlatListable,
  isParentContext,
  listParentContextStep,
  listWorkspaceResources,
  parentContextDepth,
} from "./workspace-picker";

export interface EnvSyncOptions {
  /** Directory holding `.env` / `.env.example` (the app root). */
  cwd: string;
  /** true = never prompt (agent/CI). Uses flag values or leaves unset. */
  nonInteractive: boolean;
  /** Pre-supplied env values from flags, e.g. { DATABRICKS_WAREHOUSE_ID: "abc" }. */
  values?: Record<string, string>;
  /** Databricks profile for the workspace picker (else the CLI default). */
  profile?: string;
}

/** Sentinel select value meaning "let me type the id myself". */
const MANUAL = "__manual__";

/**
 * Max resources shown in a picker select. Real workspaces can have thousands
 * (e.g. 5000+ SQL warehouses); an unbounded select is unusable. Beyond this we
 * show the first N and log how many were hidden — never silently drop — and the
 * "Enter manually" option always lets the user type an id the list omits.
 */
const PICKER_LIMIT = 25;

/** Reads a `.env`-style file into a map; empty when the file is absent. */
function readEnvFile(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {};
  return parseEnv(fs.readFileSync(file, "utf-8"));
}

/** Appends text to a file, creating it (with a trailing newline) if needed. */
function appendToFile(file: string, text: string): void {
  if (text === "") return;
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, "utf-8");
    const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    fs.writeFileSync(file, existing + sep + text);
  } else {
    fs.writeFileSync(file, text);
  }
}

/**
 * Caps a choice list to {@link PICKER_LIMIT} for display, logging how many were
 * hidden so the truncation is never silent. The caller always appends an
 * "Enter manually" option, so an omitted resource is still reachable.
 */
export function capChoices<T>(
  choices: T[],
  resourceType: string,
  limit = PICKER_LIMIT,
): T[] {
  if (choices.length <= limit) return choices;
  console.log(
    pc.dim(
      `  ${choices.length} ${resourceType}s found; showing first ${limit}. ` +
        'Use "Enter manually" if yours is not listed.',
    ),
  );
  return choices.slice(0, limit);
}

/** Free-text prompt for one env need; undefined to skip. */
async function promptText(need: EnvNeed): Promise<string | undefined> {
  const tag = need.required ? "required" : "optional";
  const answer = await text({
    message: `${need.env} (${need.resourceType}, ${tag})`,
    placeholder: need.description ?? "leave blank to skip",
  });
  if (isCancel(answer)) return undefined;
  const value = (answer ?? "").trim();
  return value === "" ? undefined : value;
}

/** Presents one workspace list as a select; MANUAL/cancel handled by caller. */
async function selectFrom(
  message: string,
  choices: { value: string; label: string }[],
): Promise<string | typeof MANUAL | null> {
  const picked = await select({
    message,
    options: [...choices, { value: MANUAL, label: "Enter manually / skip" }],
  });
  if (isCancel(picked)) return null;
  return String(picked) as string | typeof MANUAL;
}

/**
 * Type-to-filter picker over the full choice list (no cap): the user searches
 * by name/id as they type. Appends "Enter manually" so an omitted value is
 * still reachable. Returns MANUAL to fall through to free-text, or null on
 * cancel.
 */
async function autocompleteFrom(
  message: string,
  choices: { value: string; label: string }[],
): Promise<string | typeof MANUAL | null> {
  const picked = await autocomplete({
    message,
    options: [...choices, { value: MANUAL, label: "Enter manually / skip" }],
    placeholder: "type to search…",
  });
  if (isCancel(picked)) return null;
  return String(picked) as string | typeof MANUAL;
}

/**
 * Drill-down picker for parent-context types (volume→catalog/schema,
 * secret→scope, vector_search_index→endpoint). Walks each step, listing the
 * next level from the prior pick. Returns the final resource id, or undefined
 * to fall back to free-text (on cancel, empty level, or MANUAL at any step).
 */
async function pickParentContext(
  need: EnvNeed,
  profile: string | undefined,
): Promise<string | undefined> {
  const depth = parentContextDepth(need.resourceType);
  const picks: string[] = [];
  for (let i = 0; i < depth; i++) {
    const step = listParentContextStep(need.resourceType, i, picks, profile);
    if (!step || step.choices.length === 0) {
      console.log(
        pc.dim(
          `  No ${step?.key ?? need.resourceType} found — enter the id manually.`,
        ),
      );
      return undefined;
    }
    const picked = await selectFrom(
      `${need.env} — pick a ${step.key}`,
      capChoices(step.choices, step.key),
    );
    if (picked === null || picked === MANUAL) return undefined;
    picks.push(picked);
  }
  // Compose the id from the picks: most types end on a self-qualified id, but a
  // secret needs both scope and key (scope/key).
  return composeResourceId(need.resourceType, picks);
}

/**
 * Builds the value provider. Precedence: --env flag, then (interactive only) a
 * workspace picker — flat select for flat-listable types, drill-down for
 * parent-context types — else a free-text prompt. The picker degrades to
 * free-text whenever the workspace can't be listed (no profile, offline, auth
 * error, empty) so it never hard-fails.
 */
function makeProvider(opts: EnvSyncOptions): ValueProvider {
  return async (need: EnvNeed) => {
    const fromFlag = opts.values?.[need.env];
    if (fromFlag !== undefined) return fromFlag;
    if (opts.nonInteractive) return undefined;

    if (isFlatListable(need.resourceType)) {
      const { choices, truncated, error } = await listWorkspaceResources(
        need.resourceType,
        opts.profile,
      );
      if (choices.length > 0) {
        if (truncated) {
          console.log(
            pc.dim(
              `  Showing the first ${choices.length} ${need.resourceType}s; use "Enter manually" if yours isn't listed.`,
            ),
          );
        }
        const picked = await autocompleteFrom(
          `${need.env} — search ${need.resourceType}s`,
          choices,
        );
        if (picked === null) return undefined;
        if (picked !== MANUAL) return picked;
        // fall through to free-text
      } else if (error) {
        // Listing failed (usually auth/profile) — say so, don't pretend the
        // workspace is empty, and point at the fix.
        console.log(
          pc.yellow(
            `  Couldn't list ${need.resourceType}s from the workspace (${error}).`,
          ),
        );
        console.log(
          pc.dim(
            "  Enter an id manually, or re-run with --profile <name> (or set DATABRICKS_CONFIG_PROFILE) so the picker can reach the workspace.",
          ),
        );
      } else {
        console.log(
          pc.dim(
            `  No ${need.resourceType} found in the workspace — enter an id manually.`,
          ),
        );
      }
    } else if (isParentContext(need.resourceType)) {
      const picked = await pickParentContext(need, opts.profile);
      if (picked !== undefined) return picked;
      // fall through to free-text
    }

    return promptText(need);
  };
}

/**
 * Reconciles a plugin's declared resource env vars into the app's local `.env`
 * (and mirrors variable names into `.env.example`). Never overwrites keys the
 * user already set; skips platform-injected fields. Returns the per-var
 * resolutions so callers can report what happened.
 */
export async function syncEnv(
  rows: ResourceRequirementRow[],
  opts: EnvSyncOptions,
): Promise<EnvResolution[]> {
  const needs = collectEnvNeeds(rows);
  if (needs.length === 0) return [];

  const envPath = path.join(opts.cwd, ".env");
  const examplePath = path.join(opts.cwd, ".env.example");
  const existing = readEnvFile(envPath);

  const resolutions = await reconcileEnv(needs, {
    existing,
    provide: makeProvider(opts),
  });

  const written = resolutions.filter(
    (r): r is EnvResolution & { value: string } =>
      r.status === "written" && r.value !== undefined,
  );
  appendToFile(
    envPath,
    serializeEnvAppend(written.map((r) => ({ env: r.env, value: r.value }))),
  );

  // .env.example carries the variable names (no secret values), and only for
  // vars not already documented there.
  const exampleExisting = readEnvFile(examplePath);
  const newExampleKeys = needs.filter((n) => !(n.env in exampleExisting));
  appendToFile(
    examplePath,
    serializeEnvAppend(newExampleKeys.map((n) => ({ env: n.env, value: "" }))),
  );

  return resolutions;
}

/**
 * Prompts for the {@link BindingValueNeed}s that `.env` reconciliation can't
 * collect, returning a `fieldKey -> value` map for buildConfigPlan. Values are
 * not written to `.env` (these fields have no env var). Non-interactive mode
 * uses `values[fieldKey]` if provided, else leaves the field unset.
 */
export async function collectBindingValues(
  needs: BindingValueNeed[],
  opts: EnvSyncOptions,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const need of needs) {
    const fromFlag = opts.values?.[need.fieldKey];
    if (fromFlag !== undefined) {
      out[need.fieldKey] = fromFlag;
      continue;
    }
    if (opts.nonInteractive) continue;
    const answer = await text({
      message: `${need.fieldKey} (${need.resourceType}) — required for databricks.yml`,
      placeholder: need.description ?? "leave blank to set before deploy",
    });
    if (isCancel(answer)) continue;
    const value = (answer ?? "").trim();
    if (value !== "") out[need.fieldKey] = value;
  }
  return out;
}

/** Prints a concise summary of what env reconciliation did. */
export function reportEnvResolutions(resolutions: EnvResolution[]): void {
  if (resolutions.length === 0) return;
  const written = resolutions.filter((r) => r.status === "written");
  const already = resolutions.filter((r) => r.status === "already-set");
  const skipped = resolutions.filter((r) => r.status === "skipped");

  if (written.length > 0) {
    console.log(
      `${pc.green("Wrote to .env:")} ${written.map((r) => r.env).join(", ")}`,
    );
  }
  if (already.length > 0) {
    console.log(pc.dim(`Already set: ${already.map((r) => r.env).join(", ")}`));
  }
  if (skipped.length > 0) {
    console.log(
      `${pc.yellow("Left unset (set before deploy):")} ${skipped
        .map((r) => r.env)
        .join(", ")}`,
    );
  }
}
