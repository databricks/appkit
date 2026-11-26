import fs from "node:fs";
import path from "node:path";

import yaml from "js-yaml";

import { parseSessionId } from "./naming";

export type BranchMode = "dev" | "session";

interface ResourceName {
  readonly project: string;
  readonly branch?: string;
  readonly endpoint?: string;
  readonly database?: string;
}

const RESOURCE =
  /^(projects\/[^/\s]+)(?:\/branches\/([^/\s]+)(?:\/(endpoints|databases)\/([^/\s]+))?)?$/;

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

export function resourceId(name: string): string {
  return name.slice(name.lastIndexOf("/") + 1);
}

const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function parseProject(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  const id = trimmed.startsWith("projects/")
    ? trimmed.slice("projects/".length)
    : trimmed;
  return PROJECT_ID.test(id) ? `projects/${id}` : null;
}

export interface LocalTarget {
  readonly project: string | null;
  readonly endpoint: string | null;
  readonly database: string | null;
  readonly session: string | null;
}

export function readLocalTarget(env: NodeJS.ProcessEnv): LocalTarget {
  const endpoint = parseResourceName(env.LAKEBASE_ENDPOINT)?.endpoint ?? null;
  const session = env.APPKIT_DB_SESSION
    ? parseSessionId(env.APPKIT_DB_SESSION)
    : null;
  return {
    project: parseProject(env.LAKEBASE_PROJECT),
    endpoint,
    database: endpoint ? env.PGDATABASE || null : null,
    session,
  };
}

export interface DeployTarget {
  readonly branch: string;
  readonly database: string | null;
}

type Yaml = Record<string, unknown> | undefined;

/**
 * An included file's source_code_path as written, with that file's folder
 * relative to databricks.yml's: the CLI resolves the path against the file
 * that declares it, after its references. Merged as a single value.
 */
class IncludedSourcePath {
  constructor(
    readonly folder: string,
    readonly written: string,
  ) {}
}

function record(value: unknown): Yaml {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof IncludedSourcePath)
    ? (value as Record<string, unknown>)
    : undefined;
}

type BundleValue =
  | { readonly kind: "resolved"; readonly name: string }
  | { readonly kind: "unresolved"; readonly written: string };

interface PostgresBinding {
  readonly at: string;
  readonly branch: BundleValue;
  readonly database: BundleValue | null;
  readonly whole?: true;
}

export interface BundleApp {
  readonly key: string;
  readonly declaredName: string | null;
  readonly name: string | null;
  readonly sourceCodePath: BundleValue | null;
  readonly postgres: readonly PostgresBinding[];
}

interface TargetBindings {
  readonly host: BundleValue | null;
  readonly profile: BundleValue | null;
  readonly apps: readonly BundleApp[];
  readonly postgresBranch: BundleValue | null;
  readonly postgresDatabase: BundleValue | null;
}

export interface BundleTarget extends TargetBindings {
  readonly name: string;
  readonly isDefault: boolean;
  readonly overridden: (TargetBindings & { readonly file: string }) | null;
  /**
   * The same bindings with the command's BUNDLE_VAR_ variables applied ahead
   * of variable-overrides.json, as a deploy from this shell would; null when
   * none is set.
   */
  readonly environment:
    | (TargetBindings & {
        readonly variables: string;
        readonly file?: string;
      })
    | null;
}

interface Bundle {
  readonly file: string;
  readonly targets: readonly BundleTarget[];
}

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

function readVariableOverrides(
  root: string,
  target: string,
): { readonly file: string; readonly values: Record<string, unknown> } | null {
  const file = `.databricks/bundle/${target}/variable-overrides.json`;
  const full = path.join(
    root,
    ".databricks",
    "bundle",
    target,
    "variable-overrides.json",
  );
  if (!fs.existsSync(full)) return null;
  let values: Yaml;
  try {
    values = record(JSON.parse(fs.readFileSync(full, "utf-8")));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Cannot read ${file}, so the branches it deploys to are unknown: ${reason}`,
      { cause: error },
    );
  }
  if (!values) {
    throw new Error(
      `Cannot read ${file}, so the branches it deploys to are unknown: it is not a JSON object`,
    );
  }
  return { file, values };
}

const BUNDLE_VAR = "BUNDLE_VAR_";

function readBundleVariables(env: NodeJS.ProcessEnv): {
  readonly variables: string;
  readonly values: Record<string, string>;
} | null {
  const set = Object.entries(env)
    .filter(
      (entry): entry is [string, string] =>
        entry[0].startsWith(BUNDLE_VAR) &&
        entry[0].length > BUNDLE_VAR.length &&
        entry[1] !== undefined,
    )
    .sort(([a], [b]) => a.localeCompare(b));
  if (set.length === 0) return null;
  return {
    variables: set.map(([key]) => key).join(", "),
    values: Object.fromEntries(
      set.map(([key, value]) => [key.slice(BUNDLE_VAR.length), value]),
    ),
  };
}

/**
 * Files an `include:` pattern names. `*` and `?` match within one path
 * segment, as in the Databricks CLI; a pattern with other glob syntax throws
 * instead of matching nothing.
 */
function includedFiles(root: string, pattern: string): string[] {
  let paths = [root];
  for (const segment of pattern.split("/")) {
    if (/[[\]\\]/.test(segment)) {
      throw new Error(
        `Cannot read include pattern ${JSON.stringify(pattern)}, so the branches it deploys to are unknown: only * and ? are supported, not [, ] or \\.`,
      );
    }
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

/**
 * A variable's value for one target: from variable-overrides.json when it has
 * one, else the target's value, else the variable's default.
 */
function variableOf(
  bundle: Record<string, unknown>,
  target: Yaml,
  name: string,
  overrides: Record<string, unknown> | null,
): unknown {
  if (overrides && Object.hasOwn(overrides, name)) return overrides[name];
  const override = record(target?.variables)?.[name];
  if (override !== undefined) return record(override)?.default ?? override;
  return record(record(bundle.variables)?.[name])?.default;
}

const REFERENCE = /\$\{([^}]+)\}/g;
const MAX_REFERENCE_DEPTH = 10;

function resolverFor(
  bundle: Record<string, unknown>,
  target: Yaml,
  targetName: string,
  overrides: Record<string, unknown> | null,
): (value: unknown) => string | null {
  const resolve = (value: unknown, depth: number): string | null => {
    if (typeof value !== "string" || depth > MAX_REFERENCE_DEPTH) return null;
    let unresolved = false;
    const text = value.replace(REFERENCE, (_, reference: string) => {
      const resolved = reference.startsWith("var.")
        ? resolve(
            variableOf(
              bundle,
              target,
              reference.slice("var.".length),
              overrides,
            ),
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

function declaredValue(
  written: unknown,
  resolve: (value: unknown) => string | null,
): BundleValue | null {
  if (written === undefined) return null;
  const name = resolve(written);
  if (name) return { kind: "resolved", name };
  return {
    kind: "unresolved",
    written: typeof written === "string" ? written : "",
  };
}

function sourcePathValue(
  written: unknown,
  resolve: (value: unknown) => string | null,
): BundleValue | null {
  if (!(written instanceof IncludedSourcePath)) {
    return declaredValue(written, resolve);
  }
  const value = declaredValue(written.written, resolve);
  if (value?.kind !== "resolved" || path.posix.isAbsolute(value.name)) {
    return value;
  }
  return {
    kind: "resolved",
    name: path.posix.join(written.folder, value.name),
  };
}

function unresolvedAt(at: string, written: unknown): PostgresBinding {
  return {
    at,
    branch: {
      kind: "unresolved",
      written: typeof written === "string" ? written : "",
    },
    database: null,
    whole: true,
  };
}

function appPostgres(
  at: string,
  resources: unknown,
  resolve: (value: unknown) => string | null,
): PostgresBinding[] {
  if (resources == null) return [];
  if (!Array.isArray(resources)) return [unresolvedAt(at, resources)];
  return resources.flatMap((resource, index): PostgresBinding[] => {
    const here = `${at}[${index}]`;
    const item = record(resource);
    if (!item) return [unresolvedAt(here, resource)];
    if (item.postgres == null) return [];
    const binding = record(item.postgres);
    if (!binding) return [unresolvedAt(`${here}.postgres`, item.postgres)];
    return [
      {
        at: `${here}.postgres`,
        branch: bundleValue(binding.branch, resolve, "branch"),
        database:
          binding.database === undefined
            ? null
            : bundleValue(binding.database, resolve, "database"),
      },
    ];
  });
}

function bundleApps(
  apps: Record<string, unknown>,
  resolve: (value: unknown) => string | null,
): BundleApp[] {
  return Object.entries(apps).map(([key, value]) => {
    const app = record(value);
    const declared = app?.name;
    return {
      key,
      declaredName: typeof declared === "string" && declared ? declared : null,
      name: resolve(declared),
      sourceCodePath: sourcePathValue(app?.source_code_path, resolve),
      postgres: appPostgres(
        `resources.apps.${key}.resources`,
        app?.resources,
        resolve,
      ),
    };
  });
}

/** The target `databricks bundle deploy` picks without -t: the one marked default, else the only one. */
export function defaultBundleTarget(bundle: Bundle): BundleTarget | null {
  return (
    bundle.targets.find((target) => target.isDefault) ??
    (bundle.targets.length === 1 ? (bundle.targets[0] ?? null) : null)
  );
}

export function readDeployTarget(
  root: string,
  env: NodeJS.ProcessEnv,
): DeployTarget | null {
  const bundle = readBundle(root, env);
  const target = bundle ? defaultBundleTarget(bundle) : null;
  if (!target) return null;
  const bindings: TargetBindings =
    target.environment ?? target.overridden ?? target;
  const resolved = (value: BundleValue | null) =>
    value?.kind === "resolved" ? value.name : null;
  const binding = bindings.apps
    .flatMap((app) => app.postgres)
    .find((candidate) => candidate.branch.kind === "resolved");
  const branch = resolved(binding?.branch ?? bindings.postgresBranch);
  if (!branch) return null;
  return {
    branch,
    database: resolved(binding ? binding.database : bindings.postgresDatabase),
  };
}

function rebaseSourcePaths(
  file: Record<string, unknown>,
  folder: string,
): Record<string, unknown> {
  if (!folder) return file;
  const rebase = (resources: unknown) => {
    for (const app of Object.values(record(record(resources)?.apps) ?? {})) {
      const declared = record(app);
      const source = declared?.source_code_path;
      if (declared && typeof source === "string") {
        declared.source_code_path = new IncludedSourcePath(
          folder.split(path.sep).join("/"),
          source,
        );
      }
    }
  };
  rebase(file.resources);
  for (const target of Object.values(record(file.targets) ?? {})) {
    rebase(record(target)?.resources);
  }
  return file;
}

/** Without `targets:` the bundle has one target, "default". */
export function readBundle(
  root: string,
  env: NodeJS.ProcessEnv,
): Bundle | null {
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
        (merged, included) =>
          merge(
            merged,
            rebaseSourcePaths(
              parseYaml(included),
              path.relative(root, path.dirname(included)),
            ),
          ),
        main,
      ),
  ) as Record<string, unknown>;

  const fromEnv = readBundleVariables(env);
  const declared = Object.entries(record(bundle.targets) ?? {});
  const targets: Array<[string, Yaml]> =
    declared.length > 0
      ? declared.map(([name, target]) => [name, record(target)])
      : [["default", { default: true }]];
  return {
    file: path.basename(file),
    targets: targets.map(([name, target]) => {
      const apps = record(
        merge(
          record(record(bundle.resources)?.apps) ?? {},
          record(record(target?.resources)?.apps) ?? {},
        ),
      );
      const declares = (variable: string) =>
        variable in (record(bundle.variables) ?? {}) ||
        variable in (record(target?.variables) ?? {});
      const bindings = (
        overrides: Record<string, unknown> | null,
      ): TargetBindings => {
        const resolve = resolverFor(bundle, target, name, overrides);
        const variable = (
          variableName: string,
          kind: "branch" | "database",
        ): BundleValue | null =>
          declares(variableName)
            ? bundleValue(
                variableOf(bundle, target, variableName, overrides),
                resolve,
                kind,
              )
            : null;
        return {
          host: declaredValue(
            record(target?.workspace)?.host ?? record(bundle.workspace)?.host,
            resolve,
          ),
          profile: declaredValue(
            record(target?.workspace)?.profile ??
              record(bundle.workspace)?.profile,
            resolve,
          ),
          apps: bundleApps(apps ?? {}, resolve),
          postgresBranch: variable("postgres_branch", "branch"),
          postgresDatabase: variable("postgres_database", "database"),
        };
      };
      const overrides = readVariableOverrides(root, name);
      return {
        name,
        isDefault: target?.default === true,
        ...bindings(null),
        overridden: overrides
          ? { file: overrides.file, ...bindings(overrides.values) }
          : null,
        environment: fromEnv
          ? {
              variables: fromEnv.variables,
              ...(overrides ? { file: overrides.file } : {}),
              ...bindings({ ...overrides?.values, ...fromEnv.values }),
            }
          : null,
      };
    }),
  };
}

export interface UnresolvedBinding {
  readonly target: string;
  readonly at: string;
  readonly written: string;
  readonly file?: string;
  readonly environment?: string;
}

export interface DeployBoundary {
  readonly branches: ReadonlySet<string>;
  readonly unresolved: readonly UnresolvedBinding[];
}

export function readDeployBoundary(
  root: string,
  env: NodeJS.ProcessEnv,
): DeployBoundary {
  const branches = new Set<string>();
  const unresolved: UnresolvedBinding[] = [];
  for (const target of readBundle(root, env)?.targets ?? []) {
    type Source = Pick<UnresolvedBinding, "file" | "environment">;
    const views: Array<[TargetBindings, Source]> = [[target, {}]];
    if (target.overridden) {
      views.push([target.overridden, { file: target.overridden.file }]);
    }
    if (target.environment) {
      const { file, variables } = target.environment;
      views.push([
        target.environment,
        { ...(file ? { file } : {}), environment: variables },
      ]);
    }
    for (const [bindings, source] of views) {
      const add = (at: string, value: BundleValue) => {
        if (value.kind === "unresolved") {
          unresolved.push({
            target: target.name,
            at,
            written: value.written,
            ...source,
          });
          return;
        }
        const branch = parseResourceName(value.name)?.branch;
        if (branch) branches.add(branch);
      };
      for (const binding of bindings.apps.flatMap((app) => app.postgres)) {
        add(
          binding.whole ? binding.at : `${binding.at}.branch`,
          binding.branch,
        );
        if (binding.database) add(`${binding.at}.database`, binding.database);
      }
      if (bindings.postgresBranch) {
        add("variables.postgres_branch", bindings.postgresBranch);
      }
    }
  }
  return { branches, unresolved };
}
