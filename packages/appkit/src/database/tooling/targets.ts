import fs from "node:fs";
import path from "node:path";

import yaml from "js-yaml";

import { isValidSessionId } from "./naming";

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

/** What `.env` says about the local branch. Unparseable values (template placeholders) read as null. */
interface LocalTarget {
  readonly endpoint: string | null;
  readonly session: string | null;
}

export function readLocalTarget(env: NodeJS.ProcessEnv): LocalTarget {
  const endpoint = parseResourceName(env.LAKEBASE_ENDPOINT)?.endpoint ?? null;
  const session =
    env.APPKIT_DB_SESSION && isValidSessionId(env.APPKIT_DB_SESSION)
      ? env.APPKIT_DB_SESSION
      : null;
  return { endpoint, session };
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
