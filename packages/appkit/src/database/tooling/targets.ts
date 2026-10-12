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

/** An app one target of databricks.yml deploys. */
export interface BundleApp {
  /** Its key under resources.apps. */
  readonly key: string;
  /** Its name as written; null when it has none. */
  readonly declaredName: string | null;
  /** Its name with bundle references resolved; null when one needs a deploy to resolve. */
  readonly name: string | null;
  /** Its postgres resource; null when it has none. */
  readonly postgres: {
    readonly branch: string | null;
    readonly database: string | null;
  } | null;
}

/** One target of databricks.yml, with what the files alone can resolve resolved. */
export interface BundleTarget {
  readonly name: string;
  readonly isDefault: boolean;
  /** workspace.host of the target, else of the bundle. */
  readonly host: string | null;
  readonly apps: readonly BundleApp[];
  /** The target's postgres_branch and postgres_database variables. */
  readonly postgresBranch: string | null;
  readonly postgresDatabase: string | null;
}

interface Bundle {
  /** databricks.yml or databricks.yaml. */
  readonly file: string;
  readonly targets: readonly BundleTarget[];
}

type Yaml = Record<string, unknown> | undefined;

function record(value: unknown): Yaml {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Invalid YAML throws, so no check that reads the bundle passes silently. */
function parseYaml(file: string): Record<string, unknown> {
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

/** Files an `include:` pattern names. `*` and `?` match within one path segment, as in the Databricks CLI. */
function includedFiles(root: string, pattern: string): string[] {
  let paths = [root];
  for (const segment of pattern.split("/")) {
    if (!segment || segment === ".") continue;
    if (!/[*?]/.test(segment)) {
      paths = paths.map((dir) => path.join(dir, segment));
      continue;
    }
    const matcher = new RegExp(
      `^${segment
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".")}$`,
    );
    paths = paths.flatMap((dir) => {
      try {
        return fs
          .readdirSync(dir)
          .filter((entry) => matcher.test(entry))
          .map((entry) => path.join(dir, entry));
      } catch {
        return [];
      }
    });
  }
  return paths.filter((file) =>
    fs.statSync(file, { throwIfNoEntry: false })?.isFile(),
  );
}

/** Mappings merge key by key; lists of named entries (an app's resources) merge by name; anything else is replaced. */
function merge(base: unknown, override: unknown): unknown {
  const left = record(base);
  const right = record(override);
  if (left && right) {
    const merged: Record<string, unknown> = { ...left };
    for (const [key, value] of Object.entries(right)) {
      merged[key] = key in left ? merge(left[key], value) : value;
    }
    return merged;
  }
  if (Array.isArray(base) && Array.isArray(override)) {
    const named = (items: unknown[]) =>
      items.every((item) => typeof record(item)?.name === "string");
    if (named(base) && named(override)) {
      const byName = new Map(
        base.map((item) => [record(item)?.name as string, item]),
      );
      for (const item of override) {
        const name = record(item)?.name as string;
        byName.set(name, merge(byName.get(name), item));
      }
      return [...byName.values()];
    }
  }
  return override;
}

const REFERENCE = /\$\{([^}]+)\}/g;
const MAX_REFERENCE_DEPTH = 10;

/** Resolves `${var.*}`, `${bundle.target}` and `${bundle.name}` for one target; null when a reference needs a deploy to resolve. */
function resolverFor(
  bundle: Record<string, unknown>,
  target: Yaml,
  targetName: string,
): (value: unknown) => string | null {
  const variable = (name: string): unknown => {
    const override = record(target?.variables)?.[name];
    if (override !== undefined) return record(override)?.default ?? override;
    return record(record(bundle.variables)?.[name])?.default;
  };
  const resolve = (value: unknown, depth: number): string | null => {
    if (typeof value !== "string" || depth > MAX_REFERENCE_DEPTH) return null;
    let unresolved = false;
    const text = value.replace(REFERENCE, (_, reference: string) => {
      const resolved = reference.startsWith("var.")
        ? resolve(variable(reference.slice("var.".length)), depth + 1)
        : reference === "bundle.target"
          ? targetName
          : reference === "bundle.name"
            ? resolve(record(bundle.bundle)?.name, depth + 1)
            : null;
      if (resolved === null) unresolved = true;
      return resolved ?? "";
    });
    return unresolved || !text ? null : text;
  };
  return (value) => resolve(value, 0);
}

function bundleApps(
  apps: Record<string, unknown>,
  resolve: (value: unknown) => string | null,
): BundleApp[] {
  return Object.entries(apps).map(([key, value]) => {
    const app = record(value);
    const declared = app?.name;
    const resources = Array.isArray(app?.resources) ? app.resources : [];
    const postgres = resources
      .map((resource) => record(record(resource)?.postgres))
      .find((binding) => binding !== undefined);
    return {
      key,
      declaredName: typeof declared === "string" && declared ? declared : null,
      name: resolve(declared),
      postgres: postgres
        ? {
            branch:
              parseResourceName(resolve(postgres.branch) ?? undefined)
                ?.branch ?? null,
            database:
              parseResourceName(resolve(postgres.database) ?? undefined)
                ?.database ?? null,
          }
        : null,
    };
  });
}

/**
 * databricks.yml, with the files its `include:` names merged in, per target;
 * null without one. Without `targets:` the bundle has one target, "default".
 */
export function readBundle(root: string): Bundle | null {
  const file = ["databricks.yml", "databricks.yaml"]
    .map((name) => path.join(root, name))
    .find((candidate) => fs.existsSync(candidate));
  if (!file) return null;
  const main = parseYaml(file);
  const includes = Array.isArray(main.include) ? main.include : [];
  const bundle = record(
    includes
      .filter((pattern): pattern is string => typeof pattern === "string")
      .flatMap((pattern) => includedFiles(root, pattern))
      .reduce<unknown>(
        (merged, included) => merge(merged, parseYaml(included)),
        main,
      ),
  ) as Record<string, unknown>;

  const declared = Object.entries(record(bundle.targets) ?? {});
  const targets: Array<[string, Yaml]> =
    declared.length > 0
      ? declared.map(([name, target]) => [name, record(target)])
      : [["default", { default: true }]];
  return {
    file: path.basename(file),
    targets: targets.map(([name, target]) => {
      const resolve = resolverFor(bundle, target, name);
      const apps = record(
        merge(
          record(record(bundle.resources)?.apps) ?? {},
          record(record(target?.resources)?.apps) ?? {},
        ),
      );
      const variable = (variableName: string) =>
        resolve(`\${var.${variableName}}`) ?? undefined;
      return {
        name,
        isDefault: target?.default === true,
        host: resolve(
          record(target?.workspace)?.host ?? record(bundle.workspace)?.host,
        ),
        apps: bundleApps(apps ?? {}, resolve),
        postgresBranch:
          parseResourceName(variable("postgres_branch"))?.branch ?? null,
        postgresDatabase:
          parseResourceName(variable("postgres_database"))?.database ?? null,
      };
    }),
  };
}

/** The target `databricks bundle deploy` picks without -t: the one marked default, else the only one. */
export function defaultBundleTarget(bundle: Bundle): BundleTarget | null {
  return (
    bundle.targets.find((target) => target.isDefault) ??
    (bundle.targets.length === 1 ? (bundle.targets[0] ?? null) : null)
  );
}

/** Every branch a target deploys to: its apps' postgres resources, and its postgres_branch variable. */
function targetBranches(target: BundleTarget): string[] {
  return [
    ...target.apps.map((app) => app.postgres?.branch),
    target.postgresBranch,
  ].filter((branch): branch is string => !!branch);
}

/** The branch and database a target deploys to. */
export interface DeployTarget {
  readonly branch: string;
  readonly database: string | null;
}

/** The default target's branch and database; null without databricks.yml, a default target or a postgres binding. */
export function readDeployTarget(root: string): DeployTarget | null {
  const bundle = readBundle(root);
  const target = bundle ? defaultBundleTarget(bundle) : null;
  if (!target) return null;
  const bound = target.apps.find((app) => app.postgres?.branch);
  const branch = bound?.postgres?.branch ?? target.postgresBranch;
  if (!branch) return null;
  return {
    branch,
    database: bound?.postgres?.database ?? target.postgresDatabase,
  };
}

/** Every branch databricks.yml can deploy to, across targets. Empty without databricks.yml or a postgres binding. */
export function readDeployBranches(root: string): string[] {
  const bundle = readBundle(root);
  if (!bundle) return [];
  return [...new Set(bundle.targets.flatMap(targetBranches))];
}
