import { spawnSync } from "node:child_process";

/**
 * Lists a user's real Databricks workspace resources so `appkit add` can offer
 * a picker instead of blind free-text entry. Shells out to the `databricks`
 * CLI (packages/shared has no SDK access — this mirrors the existing spawnSync
 * pattern in constants.ts/add.ts). Falls back gracefully: any failure returns
 * an empty list and the caller drops to free-text entry.
 */

/** A workspace resource choice surfaced in the picker. */
export interface WorkspaceChoice {
  /** Value written to the env var (the resource id/name). */
  value: string;
  /** Human label shown in the picker (name, falling back to value). */
  label: string;
}

/**
 * How to list a resource type via the CLI. `command` is the argv after
 * `databricks`; `idField`/`labelField` name the JSON properties to read.
 * Only flat (no parent-context) types live here — parent-context types
 * (volume, uc_function, secret, vector_search_index) are handled separately.
 */
interface WorkspaceLister {
  command: string[];
  idField: string;
  labelField?: string;
}

/** Flat, top-level listable resource types (verified against CLI v1.10+). */
export const WORKSPACE_LISTERS: Record<string, WorkspaceLister> = {
  sql_warehouse: {
    command: ["warehouses", "list"],
    idField: "id",
    labelField: "name",
  },
  job: { command: ["jobs", "list"], idField: "job_id", labelField: "name" },
  serving_endpoint: {
    command: ["serving-endpoints", "list"],
    idField: "name",
    labelField: "name",
  },
  uc_connection: {
    command: ["connections", "list"],
    idField: "name",
    labelField: "full_name",
  },
  database: {
    command: ["database", "list-database-instances"],
    idField: "name",
    labelField: "name",
  },
  genie_space: {
    command: ["genie", "list-spaces"],
    idField: "space_id",
    labelField: "title",
  },
  experiment: {
    command: ["experiments", "list-experiments"],
    idField: "experiment_id",
    labelField: "name",
  },
  app: { command: ["apps", "list"], idField: "name", labelField: "name" },
};

/** True when a resource type can be listed with a flat (no-parent) command. */
export function isFlatListable(resourceType: string): boolean {
  return resourceType in WORKSPACE_LISTERS;
}

/** Runs a databricks CLI subcommand returning JSON; injectable for tests. */
export type CliRunner = (args: string[]) => {
  status: number | null;
  stdout: string;
};

const defaultRunner: CliRunner = (args) => {
  const res = spawnSync("databricks", args, { encoding: "utf-8" });
  return { status: res.status, stdout: res.stdout ?? "" };
};

/**
 * Extracts `{value,label}` choices from a parsed CLI list response. The CLI
 * returns either a bare array or an object wrapping one; we scan for the first
 * array of objects. Items missing the id field are skipped.
 */
export function toChoices(
  parsed: unknown,
  idField: string,
  labelField?: string,
): WorkspaceChoice[] {
  const arr = firstArray(parsed);
  const choices: WorkspaceChoice[] = [];
  for (const item of arr) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const id = record[idField];
    if (id === undefined || id === null) continue;
    const value = String(id);
    const rawLabel = labelField ? record[labelField] : undefined;
    const label =
      typeof rawLabel === "string" && rawLabel.length > 0
        ? `${rawLabel} (${value})`
        : value;
    choices.push({ value, label });
  }
  return choices;
}

/** Finds the first array in a CLI response (bare array or single wrapper key). */
function firstArray(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    for (const v of Object.values(parsed)) {
      if (Array.isArray(v)) return v;
    }
  }
  return [];
}

/**
 * Lists workspace resources of a flat-listable type. Returns [] on any failure
 * (unknown type, CLI missing/errored, non-JSON output) so the caller can fall
 * back to free-text entry. `profile` is passed through as `-p` when set.
 */
export function listWorkspaceResources(
  resourceType: string,
  profile?: string,
  runner: CliRunner = defaultRunner,
): WorkspaceChoice[] {
  const lister = WORKSPACE_LISTERS[resourceType];
  if (!lister) return [];

  const args = [...lister.command, "-o", "json"];
  if (profile) args.push("-p", profile);

  let result: { status: number | null; stdout: string };
  try {
    result = runner(args);
  } catch {
    return [];
  }
  if (result.status !== 0 || !result.stdout.trim()) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return [];
  }
  return toChoices(parsed, lister.idField, lister.labelField);
}
