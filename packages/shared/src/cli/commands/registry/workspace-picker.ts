import { spawnSync } from "node:child_process";
import {
  createWorkspaceClient,
  type LegacyWorkspaceClient,
} from "../../../workspace-client";

/**
 * Lists a user's real Databricks workspace resources so `appkit add` can offer
 * a picker instead of blind free-text entry.
 *
 * Flat resource types are listed via the Databricks SDK client (typed,
 * auto-paginating) obtained through the sanctioned `workspace-client` facade.
 * Parent-context types (volume, uc_function, secret, vector_search_index) still
 * shell out to the `databricks` CLI for their drill-down. Every path fails
 * soft: any error returns an empty list and the caller drops to free-text entry.
 */

/** A workspace resource choice surfaced in the picker. */
export interface WorkspaceChoice {
  /** Value written to the env var (the resource id/name). */
  value: string;
  /** Human label shown in the picker (name, falling back to value). */
  label: string;
}

/**
 * Per-type SDK lister: streams a resource type off the WorkspaceClient into
 * `{value,label}` choices. `list()` returns an async iterable of raw SDK
 * objects; `toChoice` maps each to a picker choice. The SDK auto-paginates, so
 * we simply iterate to completion.
 */
interface SdkLister {
  list: (client: LegacyWorkspaceClient) => AsyncIterable<unknown>;
  toChoice: (item: Record<string, unknown>) => WorkspaceChoice | null;
}

/** Builds a `{value,label}` from an id field and optional label field. */
function choiceFrom(
  item: Record<string, unknown>,
  idField: string,
  labelField?: string,
): WorkspaceChoice | null {
  const id = item[idField];
  if (id === undefined || id === null) return null;
  const value = String(id);
  const rawLabel = labelField ? item[labelField] : undefined;
  const label =
    typeof rawLabel === "string" && rawLabel.length > 0
      ? `${rawLabel} (${value})`
      : value;
  return { value, label };
}

/**
 * Genie listSpaces returns a single page (a Promise wrapper), not an
 * auto-paginating iterable like the other services. Adapt it to an async
 * iterable that follows `next_page_token` so large workspaces aren't capped at
 * one page. The caller stops consuming at MAX_PICKER_RESULTS, which ends the
 * loop early; the guard against a repeated token avoids an infinite loop if the
 * API ever echoes the same token back.
 */
async function* iterateGenieSpaces(
  client: LegacyWorkspaceClient,
): AsyncIterable<unknown> {
  let pageToken: string | undefined;
  do {
    const res = await client.genie.listSpaces(
      pageToken ? { page_token: pageToken } : {},
    );
    for (const space of res.spaces ?? []) yield space;
    const next = res.next_page_token;
    if (next && next === pageToken) break;
    pageToken = next;
  } while (pageToken);
}

/** Flat, top-level listable resource types, backed by SDK services. */
export const SDK_LISTERS: Record<string, SdkLister> = {
  sql_warehouse: {
    list: (c) => c.warehouses.list({}),
    toChoice: (i) => choiceFrom(i, "id", "name"),
  },
  job: {
    list: (c) => c.jobs.list({}),
    // job name lives under settings.name; id is top-level job_id
    toChoice: (i) => {
      const settings = i.settings as { name?: string } | undefined;
      return choiceFrom({ ...i, name: settings?.name }, "job_id", "name");
    },
  },
  serving_endpoint: {
    list: (c) => c.servingEndpoints.list(),
    toChoice: (i) => choiceFrom(i, "name", "name"),
  },
  uc_connection: {
    list: (c) => c.connections.list({}),
    toChoice: (i) => choiceFrom(i, "name", "full_name"),
  },
  database: {
    list: (c) => c.database.listDatabaseInstances({}),
    toChoice: (i) => choiceFrom(i, "name", "name"),
  },
  genie_space: {
    list: iterateGenieSpaces,
    toChoice: (i) => choiceFrom(i, "space_id", "title"),
  },
  experiment: {
    list: (c) => c.experiments.listExperiments({}),
    toChoice: (i) => choiceFrom(i, "experiment_id", "name"),
  },
  app: {
    list: (c) => c.apps.list({}),
    toChoice: (i) => choiceFrom(i, "name", "name"),
  },
};

/** True when a resource type can be listed flat (no parent context). */
export function isFlatListable(resourceType: string): boolean {
  return resourceType in SDK_LISTERS;
}

/**
 * Constructs a raw SDK workspace client for the given profile (or default
 * resolution), via the sanctioned `workspace-client` facade. Uses the legacy
 * escape hatch because the picker needs services (connections, database,
 * experiments, apps) the facade doesn't yet proxy directly.
 */
export function makeWorkspaceClient(profile?: string): LegacyWorkspaceClient {
  return createWorkspaceClient(
    profile ? { profile } : {},
  ).toLegacyWorkspaceClient();
}

/**
 * Max resources fetched for the picker. The SDK `list()` auto-paginates, so on
 * a large workspace (5000+ warehouses) draining it fully means many sequential
 * paged API calls before the prompt can even render. Breaking out of the
 * async iterator stops pagination early; the picker's "Enter manually" option
 * covers anything beyond the cap.
 */
export const MAX_PICKER_RESULTS = 200;

/** A listing result plus whether it was truncated at the fetch cap. */
export interface WorkspaceListing {
  choices: WorkspaceChoice[];
  truncated: boolean;
}

/**
 * Lists workspace resources of a flat-listable type via the SDK, stopping at
 * MAX_PICKER_RESULTS so pagination doesn't drain a huge workspace. Returns an
 * empty listing on any failure (unknown type, auth/config error, network) so
 * the caller can fall back to free-text entry. `clientFactory` is injectable
 * for tests.
 */
export async function listWorkspaceResources(
  resourceType: string,
  profile?: string,
  clientFactory: (
    profile?: string,
  ) => LegacyWorkspaceClient = makeWorkspaceClient,
): Promise<WorkspaceListing> {
  const lister = SDK_LISTERS[resourceType];
  if (!lister) return { choices: [], truncated: false };
  try {
    const client = clientFactory(profile);
    const choices: WorkspaceChoice[] = [];
    let truncated = false;
    for await (const item of lister.list(client)) {
      if (typeof item !== "object" || item === null) continue;
      const choice = lister.toChoice(item as Record<string, unknown>);
      if (!choice) continue;
      choices.push(choice);
      if (choices.length >= MAX_PICKER_RESULTS) {
        // Stop iterating — halts the async iterator, so no further pages fetch.
        truncated = true;
        break;
      }
    }
    return { choices, truncated };
  } catch {
    return { choices: [], truncated: false };
  }
}

/** Runs a databricks CLI subcommand returning JSON; injectable for tests. */
export type CliRunner = (args: string[]) => {
  status: number | null;
  stdout: string;
};

const defaultRunner: CliRunner = (args) => {
  // Parent-context lists can be large; raise maxBuffer well above the 1MB
  // default so a big JSON response isn't truncated into "no resources found".
  const res = spawnSync("databricks", args, {
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
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
    const choice = choiceFrom(
      item as Record<string, unknown>,
      idField,
      labelField,
    );
    if (choice) choices.push(choice);
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
 * Used for the parent-context drill-down (catalogs/schemas/scopes/endpoints).
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
  // Prior picks flow into the `databricks` CLI as positional args. A value
  // starting with `-` (e.g. a maliciously-named workspace resource surfaced in
  // an earlier step) would be parsed as a flag — refuse it so it can't inject
  // CLI options. Legitimate catalog/schema/scope/endpoint names never start
  // with `-`; an empty step drops the caller to free-text entry.
  if (parents.some((p) => p.startsWith("-"))) {
    return { key: step.key, choices: [] };
  }
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

/**
 * Builds the final resource identifier from the values picked across a
 * drill-down. Most types end on a self-qualified id (volume/uc_function list
 * `full_name`; a vector-search index name is already catalog.schema-qualified),
 * so the last pick is the whole answer. A `secret` is addressed by both its
 * scope and key (`scope/key`) — returning only the key drops the scope and
 * yields a value that can't locate the secret — so its picks are joined.
 */
export function composeResourceId(
  resourceType: string,
  picks: string[],
): string {
  if (resourceType === "secret") return picks.join("/");
  return picks[picks.length - 1];
}
