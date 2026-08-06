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
 * Runs a `databricks … list -o json` command and returns parsed choices, or
 * [] on any failure (CLI missing/errored, empty, non-JSON). `command` is the
 * argv after `databricks`; `-o json` and `-p <profile>` are appended.
 */
export function runList(
  command: string[],
  idField: string,
  labelField: string | undefined,
  profile: string | undefined,
  runner: CliRunner = defaultRunner,
): WorkspaceChoice[] {
  const args = [...command, "-o", "json"];
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
  return toChoices(parsed, idField, labelField);
}

/**
 * Lists workspace resources of a flat-listable type. Returns [] on any failure
 * so the caller can fall back to free-text entry.
 */
export function listWorkspaceResources(
  resourceType: string,
  profile?: string,
  runner: CliRunner = defaultRunner,
): WorkspaceChoice[] {
  const lister = WORKSPACE_LISTERS[resourceType];
  if (!lister) return [];
  return runList(
    lister.command,
    lister.idField,
    lister.labelField,
    profile,
    runner,
  );
}

/**
 * A drill-down step for a parent-context resource type. `list(parents)` builds
 * the CLI argv given the values picked in prior steps (e.g. [catalog] → schema
 * list command). `key` labels the step for prompts.
 */
export interface ParentContextStep {
  key: string;
  list: (parents: string[]) => { command: string[] } & {
    idField: string;
    labelField?: string;
  };
}

/**
 * Drill-down chains for parent-context resource types. Each ends by listing
 * the resource itself; earlier steps list the parents to pick first.
 * Positional-arg CLI gotcha: `databricks schemas list <CATALOG>` etc. take the
 * parent as a positional, not a flag.
 */
export const PARENT_CONTEXT_CHAINS: Record<string, ParentContextStep[]> = {
  volume: [
    {
      key: "catalog",
      list: () => ({
        command: ["catalogs", "list"],
        idField: "name",
        labelField: "name",
      }),
    },
    {
      key: "schema",
      list: ([catalog]) => ({
        command: ["schemas", "list", catalog],
        idField: "name",
        labelField: "name",
      }),
    },
    {
      key: "volume",
      list: ([catalog, schema]) => ({
        command: ["volumes", "list", catalog, schema],
        idField: "full_name",
        labelField: "name",
      }),
    },
  ],
  uc_function: [
    {
      key: "catalog",
      list: () => ({
        command: ["catalogs", "list"],
        idField: "name",
        labelField: "name",
      }),
    },
    {
      key: "schema",
      list: ([catalog]) => ({
        command: ["schemas", "list", catalog],
        idField: "name",
        labelField: "name",
      }),
    },
    {
      key: "function",
      list: ([catalog, schema]) => ({
        command: ["functions", "list", catalog, schema],
        idField: "full_name",
        labelField: "name",
      }),
    },
  ],
  secret: [
    {
      key: "scope",
      list: () => ({
        command: ["secrets", "list-scopes"],
        idField: "name",
        labelField: "name",
      }),
    },
    {
      key: "key",
      list: ([scope]) => ({
        command: ["secrets", "list-secrets", scope],
        idField: "key",
        labelField: "key",
      }),
    },
  ],
  vector_search_index: [
    {
      key: "endpoint",
      list: () => ({
        command: ["vector-search-endpoints", "list-endpoints"],
        idField: "name",
        labelField: "name",
      }),
    },
    {
      key: "index",
      list: ([endpoint]) => ({
        command: ["vector-search-indexes", "list-indexes", endpoint],
        idField: "name",
        labelField: "name",
      }),
    },
  ],
};

/** True when a resource type needs a parent-context drill-down to list. */
export function isParentContext(resourceType: string): boolean {
  return resourceType in PARENT_CONTEXT_CHAINS;
}

/** One resolved step of a drill-down: the choices to present at this level. */
export interface DrillStep {
  key: string;
  choices: WorkspaceChoice[];
}

/**
 * Lists the choices for a single drill-down step given the values picked so
 * far. Returns [] on failure. The caller drives the interaction (present
 * `choices`, collect a pick, call again with it appended to `parents`).
 */
export function listParentContextStep(
  resourceType: string,
  stepIndex: number,
  parents: string[],
  profile?: string,
  runner: CliRunner = defaultRunner,
): DrillStep | null {
  const chain = PARENT_CONTEXT_CHAINS[resourceType];
  if (!chain || stepIndex >= chain.length) return null;
  const step = chain[stepIndex];
  const spec = step.list(parents);
  return {
    key: step.key,
    choices: runList(
      spec.command,
      spec.idField,
      spec.labelField,
      profile,
      runner,
    ),
  };
}

/** Number of drill-down steps for a parent-context type (0 if not one). */
export function parentContextDepth(resourceType: string): number {
  return PARENT_CONTEXT_CHAINS[resourceType]?.length ?? 0;
}
