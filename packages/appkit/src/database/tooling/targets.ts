import fs from "node:fs";
import path from "node:path";

import yaml from "js-yaml";

import { isValidSessionId } from "./naming";

export type BranchMode = "dev" | "session";

/** Full resource names, e.g. branch = "projects/p/branches/b". */
interface ResourceName {
  readonly project: string;
  readonly branch?: string;
  readonly endpoint?: string;
  readonly database?: string;
}

const RESOURCE =
  /^(projects\/[^/\s]+)(?:\/branches\/([^/\s]+)(?:\/(endpoints|databases)\/([^/\s]+))?)?$/;

/** null for anything that is not a Lakebase project/branch/endpoint/database name (e.g. a placeholder). */
export function parseResourceName(
  name: string | undefined,
): ResourceName | null {
  const match = name ? RESOURCE.exec(name.trim()) : null;
  if (!match) return null;
  const [, project, branchId, kind, leafId] = match;
  if (!project) return null;
  const branch = branchId ? `${project}/branches/${branchId}` : undefined;
  const leaf = branch && leafId ? `${branch}/${kind}/${leafId}` : undefined;
  return {
    project,
    ...(branch ? { branch } : {}),
    ...(kind === "endpoints" && leaf ? { endpoint: leaf } : {}),
    ...(kind === "databases" && leaf ? { database: leaf } : {}),
  };
}

/** The last path segment of a resource name. */
export function resourceId(name: string): string {
  return name.slice(name.lastIndexOf("/") + 1);
}

const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * LAKEBASE_PROJECT as a project resource name: accepts "projects/<id>" or a bare
 * "<id>"; null for anything else (e.g. the .env.example placeholder).
 */
export function parseProject(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  const id = trimmed.startsWith("projects/")
    ? trimmed.slice("projects/".length)
    : trimmed;
  return PROJECT_ID.test(id) ? `projects/${id}` : null;
}

/** What `.env` says about the local branch. Unparseable values (template placeholders) read as null. */
export interface LocalTarget {
  /** LAKEBASE_PROJECT, normalized to "projects/<id>". */
  readonly project: string | null;
  readonly endpoint: string | null;
  readonly database: string | null;
  readonly session: string | null;
}

export function readLocalTarget(env: NodeJS.ProcessEnv): LocalTarget {
  const endpoint = parseResourceName(env.LAKEBASE_ENDPOINT)?.endpoint ?? null;
  const session =
    env.APPKIT_DB_SESSION && isValidSessionId(env.APPKIT_DB_SESSION)
      ? env.APPKIT_DB_SESSION
      : null;
  return {
    project: parseProject(env.LAKEBASE_PROJECT),
    endpoint,
    // Without a real endpoint PGDATABASE is a template placeholder too.
    database: endpoint ? env.PGDATABASE || null : null,
    session,
  };
}

/** The branch the bundle's default target deploys to. */
export interface DeployTarget {
  readonly branch: string;
  readonly database: string | null;
}

type Yaml = Record<string, unknown> | undefined;

function record(value: unknown): Yaml {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** databricks.yml, parsed; null without one. Invalid YAML throws, so no check that reads it passes silently. */
function readBundle(root: string): Record<string, unknown> | null {
  const file = ["databricks.yml", "databricks.yaml"]
    .map((name) => path.join(root, name))
    .find((candidate) => fs.existsSync(candidate));
  if (!file) return null;
  try {
    return record(yaml.load(fs.readFileSync(file, "utf-8"))) ?? {};
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : "";
    throw new Error(
      `Cannot read ${path.basename(file)}, so the branches it deploys to are unknown: ${reason}`,
      { cause: error },
    );
  }
}

/** A target's value for a bundle variable, else the variable's default. */
function variableOf(
  bundle: Record<string, unknown>,
  target: Yaml,
  name: string,
): string | null {
  const value =
    record(target?.variables)?.[name] ??
    record(record(bundle.variables)?.[name])?.default ??
    null;
  return typeof value === "string" && value ? value : null;
}

/** Default target's postgres_branch / postgres_database variables; null without databricks.yml or binding. */
export function readDeployTarget(root: string): DeployTarget | null {
  const bundle = readBundle(root);
  if (!bundle) return null;
  const targets = record(bundle.targets) ?? {};
  const target =
    Object.values(targets)
      .map(record)
      .find((candidate) => candidate?.default === true) ??
    record(targets.default);

  const branch = parseResourceName(
    variableOf(bundle, target, "postgres_branch") ?? undefined,
  )?.branch;
  if (!branch) return null;
  const database =
    parseResourceName(
      variableOf(bundle, target, "postgres_database") ?? undefined,
    )?.database ?? null;
  return { branch, database };
}

/**
 * Every branch databricks.yml can deploy to: each target's postgres_branch and
 * the variable's default. Empty without databricks.yml or a postgres binding.
 */
export function readDeployBranches(root: string): string[] {
  const bundle = readBundle(root);
  if (!bundle) return [];
  const targets = [
    undefined,
    ...Object.values(record(bundle.targets) ?? {}).map(record),
  ];
  const branches = targets
    .map(
      (target) =>
        parseResourceName(
          variableOf(bundle, target, "postgres_branch") ?? undefined,
        )?.branch,
    )
    .filter((branch): branch is string => !!branch);
  return [...new Set(branches)];
}
