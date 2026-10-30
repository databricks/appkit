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

/**
 * A branch or database databricks.yml names, as far as the checkout's files
 * resolve it. A reference that is not declared at all has no value: the
 * binding or variable that holds it is absent instead.
 */
type BundleValue =
  /** A full resource name, e.g. "projects/p/branches/b". */
  | { readonly kind: "resolved"; readonly name: string }
  /** As written: a `${…}` only a deploy resolves, no value, or not a resource name. */
  | { readonly kind: "unresolved"; readonly written: string };

/** One postgres resource of an app. */
interface PostgresBinding {
  /** Where it is in the merged bundle, e.g. "resources.apps.app.resources[0].postgres". */
  readonly at: string;
  readonly branch: BundleValue;
  /** null when the binding names no database. */
  readonly database: BundleValue | null;
}

/** An app one target of databricks.yml deploys. */
interface BundleApp {
  /** Its key under resources.apps. */
  readonly key: string;
  /** Every postgres resource it has. */
  readonly postgres: readonly PostgresBinding[];
}

/** One target of databricks.yml, with what the files alone can resolve resolved. */
interface BundleTarget {
  readonly name: string;
  readonly apps: readonly BundleApp[];
  /** The target's postgres_branch variable; null when the bundle declares none. */
  readonly postgresBranch: BundleValue | null;
}

interface Bundle {
  readonly targets: readonly BundleTarget[];
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

/** A target's value for a bundle variable, else the variable's default. */
function variableOf(
  bundle: Record<string, unknown>,
  target: Yaml,
  name: string,
): unknown {
  const override = record(target?.variables)?.[name];
  if (override !== undefined) return record(override)?.default ?? override;
  return record(record(bundle.variables)?.[name])?.default;
}

const REFERENCE = /\$\{([^}]+)\}/g;
const MAX_REFERENCE_DEPTH = 10;

/** Resolves `${var.*}`, `${bundle.target}` and `${bundle.name}` for one target; null when a reference needs a deploy to resolve. */
function resolverFor(
  bundle: Record<string, unknown>,
  target: Yaml,
  targetName: string,
): (value: unknown) => string | null {
  const resolve = (value: unknown, depth: number): string | null => {
    if (typeof value !== "string" || depth > MAX_REFERENCE_DEPTH) return null;
    let unresolved = false;
    const text = value.replace(REFERENCE, (_, reference: string) => {
      const resolved = reference.startsWith("var.")
        ? resolve(
            variableOf(bundle, target, reference.slice("var.".length)),
            depth + 1,
          )
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

function bundleValue(
  written: unknown,
  resolve: (value: unknown) => string | null,
  kind: "branch" | "database",
): BundleValue {
  const name = parseResourceName(resolve(written) ?? undefined)?.[kind];
  if (name) return { kind: "resolved", name };
  return {
    kind: "unresolved",
    written: typeof written === "string" ? written : "",
  };
}

function bundleApps(
  apps: Record<string, unknown>,
  resolve: (value: unknown) => string | null,
): BundleApp[] {
  return Object.entries(apps).map(([key, value]) => {
    const app = record(value);
    const resources = Array.isArray(app?.resources) ? app.resources : [];
    const postgres = resources.flatMap((resource, index): PostgresBinding[] => {
      const binding = record(record(resource)?.postgres);
      if (!binding) return [];
      return [
        {
          at: `resources.apps.${key}.resources[${index}].postgres`,
          branch: bundleValue(binding.branch, resolve, "branch"),
          database:
            binding.database === undefined
              ? null
              : bundleValue(binding.database, resolve, "database"),
        },
      ];
    });
    return { key, postgres };
  });
}

/**
 * databricks.yml, with the files its `include:` names merged in, per target;
 * null without one. Without `targets:` the bundle has one target, "default".
 */
function readBundle(root: string): Bundle | null {
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
    targets: targets.map(([name, target]) => {
      const resolve = resolverFor(bundle, target, name);
      const apps = record(
        merge(
          record(record(bundle.resources)?.apps) ?? {},
          record(record(target?.resources)?.apps) ?? {},
        ),
      );
      const declaresBranch =
        "postgres_branch" in (record(bundle.variables) ?? {}) ||
        "postgres_branch" in (record(target?.variables) ?? {});
      return {
        name,
        apps: bundleApps(apps ?? {}, resolve),
        postgresBranch: declaresBranch
          ? bundleValue(
              variableOf(bundle, target, "postgres_branch"),
              resolve,
              "branch",
            )
          : null,
      };
    }),
  };
}

/** A reference in databricks.yml the checkout's files cannot resolve to a branch or database. */
export interface UnresolvedBinding {
  readonly target: string;
  /** Where it is written, e.g. "resources.apps.app.resources[0].postgres.branch". */
  readonly at: string;
  readonly written: string;
}

/** What databricks.yml deploys to, read from this checkout's files only. */
export interface DeployBoundary {
  /** Every branch any target binds, through an app's postgres resources or its postgres_branch variable. */
  readonly branches: ReadonlySet<string>;
  /** While any exists, any branch may be one a target deploys to. */
  readonly unresolved: readonly UnresolvedBinding[];
}

/**
 * Every branch databricks.yml can deploy to, across targets, and every
 * reference it cannot resolve. Empty without databricks.yml or a postgres
 * binding. A database counts for the branch it is on.
 */
export function readDeployBoundary(root: string): DeployBoundary {
  const branches = new Set<string>();
  const unresolved: UnresolvedBinding[] = [];
  for (const target of readBundle(root)?.targets ?? []) {
    const add = (at: string, value: BundleValue) => {
      if (value.kind === "unresolved") {
        unresolved.push({ target: target.name, at, written: value.written });
        return;
      }
      const branch = parseResourceName(value.name)?.branch;
      if (branch) branches.add(branch);
    };
    for (const binding of target.apps.flatMap((app) => app.postgres)) {
      add(`${binding.at}.branch`, binding.branch);
      if (binding.database) add(`${binding.at}.database`, binding.database);
    }
    if (target.postgresBranch) {
      add("variables.postgres_branch", target.postgresBranch);
    }
  }
  return { branches, unresolved };
}
