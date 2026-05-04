/**
 * `appkit db init` — one-command Lakebase onboarding.
 *
 * Both flows always create or reuse a per-user dev branch (cloned from the
 * project's default branch) and write `.env` so the database plugin can
 * connect. What differs is the direction of the schema sync that follows:
 *
 *   - migrate:    schema.ts is the source of truth.
 *                 Generates + applies a migration so the live branch matches
 *                 schema.ts. Optionally runs seed.sql.
 *   - introspect: the live branch is the source of truth.
 *                 Writes schema.ts from the live tables, then verifies that
 *                 schema.ts matches the live state.
 *
 * Auto-detect picks `migrate` when the target schema has zero tables and
 * `introspect` when it has any. Pass `--from migrate|introspect` to override.
 *
 * Calls the Databricks CLI for Lakebase resource lookups (profiles, projects,
 * branches, endpoints, databases). Reuses existing `setupDev`, `runIntrospect`,
 * and `verifyDatabase` runners as the underlying primitives.
 *
 * Architecture: a thin top-level `runInit` orchestrator delegates to named
 * phase helpers (`pickWorkspace`, `resolveDevBranch`, `resolveLakebaseResources`,
 * `applyEnvUpdates`, `resolveMode`, `delegate`). Phases are kept inside this
 * single file per the implementation tracker spec, but each is independently
 * testable through the `RunInitDeps` injection point.
 */

import crypto from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  autocomplete,
  confirm,
  intro,
  isCancel,
  outro,
  select,
  spinner,
} from "@clack/prompts";
import { Command } from "commander";
import { execa } from "execa";
import { runIntrospect } from "./introspect";
import { dropAllAppTables } from "./migrate";
import { setupDev } from "./setup-dev";
import {
  bullet,
  check,
  databasePaths,
  type LakebasePool,
  loadSchemaFile,
  openLakebasePool,
  runCommandAction,
  warn,
} from "./shared";
import { verifyDatabase } from "./verify";

/* ============================================================ */
/* Public types                                                  */
/* ============================================================ */

/**
 * Direction of the schema sync that follows the workspace + branch + .env
 * setup. Names mirror the underlying CLI commands so the user sees exactly
 * which primitives `db init` is going to compose.
 *
 * - `migrate`: generate + apply a migration so the live branch matches schema.ts.
 * - `introspect`: write schema.ts from the live tables.
 * - `reset`: drop every app table in the branch, then fall through to the
 *   migrate flow. Intended for dev branches whose schema has diverged from
 *   `schema.ts` and should be re-created from scratch. Cheap and reversible
 *   because dev branches are per-user clones of the project's default
 *   branch — `db init` can always recreate the state.
 */
export type InitMode = "migrate" | "introspect" | "reset";

export interface RunInitOptions {
  profile?: string;
  project?: string;
  from?: InitMode;
  schema?: string;
  seed?: boolean;
  /** Skip every confirmation prompt and refuse when a default is unavailable. */
  yes?: boolean;
  /** Override the project root used to resolve `.env` and `config/database/`. */
  cwd?: string;
}

export type EnvWriter = (envPath: string, updates: EnvUpdates) => void;

/**
 * Injection points used by tests so `runInit` can be exercised end-to-end
 * without contacting Databricks, hitting Lakebase, or mutating the developer's
 * `.env` and `process.env`.
 */
export interface RunInitDeps {
  /** Replace the Databricks CLI runner. */
  databricksCli?: CliRunner;
  /** Replace the table-count probe used to auto-detect migrate vs introspect. */
  probeTableCount?: (schema: string) => Promise<number>;
  /** Replace `setupDev` (the migrate-flow runner). */
  setupDev?: typeof setupDev;
  /** Replace `runIntrospect` (the introspect-flow runner). */
  runIntrospect?: typeof runIntrospect;
  /** Replace `verifyDatabase` (post-introspect validator). */
  verifyDatabase?: typeof verifyDatabase;
  /**
   * Replace the schema loader used by the migrate/reset preflight to detect
   * "file exists but declares no tables". Defaults to the real `loadSchemaFile`
   * from `./shared`. Tests inject a fake so fixtures don't need real Drizzle
   * tables.
   */
  loadSchemaFile?: (schemaFile: string) => Promise<unknown>;
  /**
   * Replace `dropAllAppTables` used by the `reset` flow. Defaults to the real
   * implementation from `./migrate` that hits the live pool.
   */
  dropAllAppTables?: typeof dropAllAppTables;
  /** Replace the `.env` writer. Defaults to file write + `process.env` mutation. */
  applyEnvUpdates?: EnvWriter;
  /** Whether stdin is interactive. Defaults to `process.stdin.isTTY === true`. */
  isInteractive?: () => boolean;
}

/* ============================================================ */
/* Constants                                                     */
/* ============================================================ */

/**
 * Env keys this command owns. Anything outside this list is preserved verbatim
 * in `.env`. Increment-only — removing a key here is a breaking change for
 * apps that already source `.env` and rely on the variable.
 */
export const OWNED_ENV_KEYS = [
  "DATABRICKS_HOST",
  "DATABRICKS_CONFIG_PROFILE",
  "LAKEBASE_ENDPOINT",
  "PGHOST",
  "PGDATABASE",
  "PGUSER",
  "PGPORT",
  "PGSSLMODE",
] as const;

export type OwnedEnvKey = (typeof OWNED_ENV_KEYS)[number];
export type EnvUpdates = Partial<Record<OwnedEnvKey, string>>;

const PG_PORT = "5432";
const PG_SSLMODE = "require";

/** Length of the autocomplete-vs-select threshold for prompt UX. */
const PROMPT_AUTOCOMPLETE_THRESHOLD = 8;

/* ============================================================ */
/* Runner                                                        */
/* ============================================================ */

export async function runInit(
  options: RunInitOptions = {},
  deps: RunInitDeps = {},
): Promise<void> {
  const cli = deps.databricksCli ?? defaultDatabricksCli;
  const fns = {
    setupDev: deps.setupDev ?? setupDev,
    runIntrospect: deps.runIntrospect ?? runIntrospect,
    verifyDatabase: deps.verifyDatabase ?? verifyDatabase,
    probeTableCount: deps.probeTableCount ?? defaultProbeTableCount,
    loadSchemaFile: deps.loadSchemaFile ?? loadSchemaFile,
    dropAllAppTables: deps.dropAllAppTables ?? dropAllAppTables,
    applyEnvUpdates: deps.applyEnvUpdates ?? defaultApplyEnvUpdates,
    isInteractive: deps.isInteractive ?? defaultIsInteractive,
  };
  const cwd = options.cwd ?? process.cwd();
  const interactive = !options.yes && fns.isInteractive();

  intro("appkit db init");

  const workspace = await pickWorkspace(cli, options, interactive);
  const { user, branch } = await resolveDevBranch(cli, workspace);
  const resources = await resolveLakebaseResources(
    cli,
    workspace.profile,
    branch.fullName,
  );

  const envPath = path.join(databasePaths(cwd).root, ".env");
  const envUpdates = buildEnvUpdates({ workspace, user, ...resources });
  fns.applyEnvUpdates(envPath, envUpdates);
  console.log(check(`.env updated (${path.relative(cwd, envPath)})`));

  const mode = await resolveMode(options, fns.probeTableCount, interactive);
  await delegateToFlow(mode, options, cwd, fns, interactive);

  outro("Database setup complete. Start your dev server.");
}

/* ============================================================ */
/* Phase 1: workspace (profile + project + host)                 */
/* ============================================================ */

interface ResolvedWorkspace {
  profile: string;
  profileHost: string;
  project: string;
}

/**
 * Pick the Databricks profile and Lakebase project, returning them along with
 * the profile's host URL. Combined into one phase so we list profiles once
 * (instead of once for the prompt and once again later for the host).
 */
async function pickWorkspace(
  cli: CliRunner,
  options: RunInitOptions,
  interactive: boolean,
): Promise<ResolvedWorkspace> {
  const profiles = await listProfiles(cli);
  const profile = await pickProfile(profiles, options.profile, interactive);
  console.log(bullet(`Profile: ${profile}`));

  const profileHost = profiles.find((p) => p.name === profile)?.host ?? "";

  const project = await pickProject(cli, profile, options.project, interactive);
  console.log(bullet(`Project: ${project}`));

  return { profile, profileHost, project };
}

async function pickProfile(
  profiles: ProfileSummary[],
  preselected: string | undefined,
  interactive: boolean,
): Promise<string> {
  if (profiles.length === 0) {
    throw new Error(
      "No Databricks profiles found. Run `databricks auth login` first.",
    );
  }
  if (preselected) {
    if (!profiles.some((p) => p.name === preselected)) {
      throw new Error(
        `Profile "${preselected}" not found in ~/.databrickscfg. Available: ${profiles.map((p) => p.name).join(", ")}.`,
      );
    }
    return preselected;
  }
  if (profiles.length === 1) return profiles[0].name;
  if (!interactive) {
    throw new Error(
      `Multiple Databricks profiles available; specify --profile (one of: ${profiles.map((p) => p.name).join(", ")}).`,
    );
  }

  const choices = profiles.map((p) => ({
    value: p.name,
    label: p.name,
    hint: p.host,
  }));
  return promptChoice("Databricks profile", choices);
}

async function pickProject(
  cli: CliRunner,
  profile: string,
  preselected: string | undefined,
  interactive: boolean,
): Promise<string> {
  const projects = await withSpinner(
    "Loading Lakebase projects",
    (list) => `Found ${list.length} Lakebase project(s)`,
    async () => listProjects(cli, profile),
  );

  if (projects.length === 0) {
    throw new Error(
      `No Lakebase projects visible to profile "${profile}". Create one in the Databricks workspace, then re-run.`,
    );
  }
  if (preselected) {
    if (!projects.some((p) => p.name === preselected)) {
      throw new Error(
        `Project "${preselected}" not visible to profile "${profile}". Available: ${projects.map((p) => p.name).join(", ")}.`,
      );
    }
    return preselected;
  }
  if (projects.length === 1) return projects[0].name;
  if (!interactive) {
    throw new Error(
      `Multiple Lakebase projects available; specify --project (one of: ${projects.map((p) => p.name).join(", ")}).`,
    );
  }

  const choices = projects.map((p) => ({
    value: p.name,
    label: p.displayName,
    hint: p.name,
  }));
  return promptChoice("Lakebase project", choices);
}

async function promptChoice(
  message: string,
  choices: Array<{ value: string; label: string; hint?: string }>,
): Promise<string> {
  // Workspaces with many profiles/projects benefit from typing-to-filter once
  // the list grows past a small threshold; below that, a plain select is fine.
  const useAutocomplete = choices.length > PROMPT_AUTOCOMPLETE_THRESHOLD;
  const choice = useAutocomplete
    ? await autocomplete({
        message: `${message} (type to filter)`,
        placeholder: "start typing to filter…",
        options: choices,
      })
    : await select({ message, options: choices });

  if (isCancel(choice)) throw new Error("Cancelled.");
  return String(choice);
}

/* ============================================================ */
/* Phase 2: dev branch (per-user)                                */
/* ============================================================ */

interface ResolvedBranch {
  /** Short id used to address the branch in CLI commands (`dev-{slug}-{hash}`). */
  id: string;
  /** Resource name returned by Lakebase (`projects/foo/branches/dev-...`). */
  fullName: string;
  /** Whether we created the branch on this run, vs. reused an existing one. */
  created: boolean;
}

interface ResolvedUserAndBranch {
  user: UserSummary;
  branch: ResolvedBranch;
}

async function resolveDevBranch(
  cli: CliRunner,
  workspace: ResolvedWorkspace,
): Promise<ResolvedUserAndBranch> {
  const user = await withSpinner(
    "Resolving Databricks user",
    (u) => `User: ${u.userName}`,
    () => getCurrentUser(cli, workspace.profile),
  );
  const branchId = deriveDevBranchName(user);

  const branches = await withSpinner(
    `Looking up branches in ${workspace.project}`,
    (list) => `Found ${list.length} branch(es) in ${workspace.project}`,
    () => listBranches(cli, workspace.profile, workspace.project),
  );

  const existing = branches.find((b) => b.id === branchId);
  if (existing) {
    console.log(bullet(`Reusing dev branch: ${branchId}`));
    return {
      user,
      branch: { id: branchId, fullName: existing.name, created: false },
    };
  }

  const sourceBranch = branches.find((b) => b.isDefault);
  if (!sourceBranch) {
    throw new Error(
      `Project ${workspace.project} has no default branch to clone from. ` +
        `Create one first via the Databricks workspace or CLI.`,
    );
  }
  const created = await withSpinner(
    `Creating dev branch ${branchId} from ${sourceBranch.id} (this can take a minute)`,
    () => `Created dev branch: ${branchId}`,
    () =>
      createBranch(
        cli,
        workspace.profile,
        workspace.project,
        branchId,
        sourceBranch.id,
      ),
  );
  return {
    user,
    branch: { id: branchId, fullName: created.name, created: true },
  };
}

/* ============================================================ */
/* Phase 3: Lakebase resources (endpoint + database)             */
/* ============================================================ */

interface ResolvedResources {
  endpoint: EndpointSummary;
  database: DatabaseSummary;
}

/**
 * Fetch endpoint and database concurrently — they are independent reads
 * keyed by the same branch resource name and each is a ~500ms shellout to
 * the Databricks CLI.
 */
async function resolveLakebaseResources(
  cli: CliRunner,
  profile: string,
  branchFullName: string,
): Promise<ResolvedResources> {
  return withSpinner(
    "Resolving endpoint and database",
    (r) => `Endpoint: ${r.endpoint.host}`,
    async () => {
      const [endpoint, database] = await Promise.all([
        getEndpoint(cli, profile, branchFullName),
        getDatabase(cli, profile, branchFullName),
      ]);
      return { endpoint, database };
    },
  );
}

/* ============================================================ */
/* Phase 4: env updates                                          */
/* ============================================================ */

function buildEnvUpdates(input: {
  workspace: ResolvedWorkspace;
  user: UserSummary;
  endpoint: EndpointSummary;
  database: DatabaseSummary;
}): EnvUpdates {
  return {
    DATABRICKS_HOST: input.workspace.profileHost,
    DATABRICKS_CONFIG_PROFILE: input.workspace.profile,
    LAKEBASE_ENDPOINT: input.endpoint.name,
    PGHOST: input.endpoint.host,
    PGDATABASE: input.database.postgresDatabase,
    PGUSER: input.user.userName,
    PGPORT: PG_PORT,
    PGSSLMODE: PG_SSLMODE,
  };
}

/**
 * Default env writer: persists to disk AND mirrors into `process.env` so the
 * follow-on phases (`probeTableCount`, `setupDev`, `runIntrospect`,
 * `verifyDatabase`) see the just-written values without requiring the user to
 * source the file or re-invoke the command.
 *
 * Tests typically pass a stub via `RunInitDeps.applyEnvUpdates` to keep the
 * mutation out of the test process's globals.
 */
function defaultApplyEnvUpdates(envPath: string, updates: EnvUpdates): void {
  writeEnvKeys(envPath, updates);
  for (const key of OWNED_ENV_KEYS) {
    const value = updates[key];
    if (value !== undefined) {
      process.env[key] = value;
    }
  }
}

/* ============================================================ */
/* Phase 5: mode resolution                                      */
/* ============================================================ */

async function resolveMode(
  options: RunInitOptions,
  probeTableCount: (schema: string) => Promise<number>,
  interactive: boolean,
): Promise<InitMode> {
  // Explicit --from short-circuits the probe + prompt and is honored verbatim
  // (no auto-pivot to the other mode based on probe results).
  if (options.from) return options.from;

  const schemaName = options.schema ?? "public";
  const suggested = await probeMode(schemaName, probeTableCount);

  if (!interactive) {
    if (!suggested) {
      throw new Error(
        `Could not auto-detect setup mode for schema "${schemaName}" and stdin is not interactive. ` +
          `Pass --from migrate or --from introspect.`,
      );
    }
    console.log(bullet(`Auto-detected mode: ${suggested}`));
    return suggested;
  }

  return pickMode(suggested);
}

async function probeMode(
  schemaName: string,
  probeTableCount: (schema: string) => Promise<number>,
): Promise<InitMode | null> {
  const probeSpin = spinner();
  probeSpin.start(`Probing schema "${schemaName}" for existing tables`);
  try {
    const tableCount = await probeTableCount(schemaName);
    const suggested: InitMode = tableCount === 0 ? "migrate" : "introspect";
    probeSpin.stop(
      tableCount === 0
        ? `Schema "${schemaName}" is empty — suggesting "migrate" (apply schema.ts to the branch)`
        : `Schema "${schemaName}" has ${tableCount} table(s) — suggesting "introspect" (import the branch into schema.ts)`,
    );
    return suggested;
  } catch (error) {
    probeSpin.stop(
      `Could not probe schema "${schemaName}" (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
    return null;
  }
}

async function pickMode(suggested: InitMode | null): Promise<InitMode> {
  const message = suggested
    ? `Setup action (suggesting "${suggested}")`
    : "Setup action";
  const choice = await select<InitMode>({
    message,
    initialValue: suggested ?? "migrate",
    options: [
      {
        value: "migrate",
        label: "Apply schema.ts → branch (migrate)",
        hint: "Generate a migration from config/database/schema.ts and run it",
      },
      {
        value: "introspect",
        label: "Import branch tables → schema.ts (introspect)",
        hint: "Write config/database/schema.ts from the branch's existing tables",
      },
      {
        value: "reset",
        label: "Drop all tables + apply schema.ts (reset)",
        hint: "Wipe the dev branch and re-apply schema.ts from scratch",
      },
    ],
  });
  if (isCancel(choice)) throw new Error("Cancelled.");
  return choice as InitMode;
}

/* ============================================================ */
/* Phase 6: delegate to migrate | introspect | reset             */
/* ============================================================ */

async function delegateToFlow(
  mode: InitMode,
  options: RunInitOptions,
  cwd: string,
  fns: {
    setupDev: typeof setupDev;
    runIntrospect: typeof runIntrospect;
    verifyDatabase: typeof verifyDatabase;
    loadSchemaFile: (schemaFile: string) => Promise<unknown>;
    dropAllAppTables: typeof dropAllAppTables;
  },
  interactive: boolean,
): Promise<void> {
  if (mode === "migrate" || mode === "reset") {
    const paths = databasePaths(cwd);
    const preflight = await preflightMigrate(paths, fns.loadSchemaFile);
    if (!preflight.ok) return;

    if (mode === "reset") {
      const schemaName = options.schema ?? "public";
      console.log(bullet(`Dropping all tables in schema "${schemaName}"`));
      await fns.dropAllAppTables({ schema: schemaName });
    }

    const seedFile = path.join(paths.configDir, "seed.sql");
    const seed = await resolveSeedChoice(options, seedFile, interactive);
    await fns.setupDev({ name: "init", seed, force: false });
    return;
  }

  const schemaName = options.schema ?? "public";
  await fns.runIntrospect({ schema: schemaName });
  await fns.verifyDatabase({});
}

/**
 * Gate the migrate/reset flow on a usable `config/database/schema.ts`.
 *
 * Two soft-fail cases where we want guidance, not a thrown stack trace:
 *   - No schema file: print a starter snippet and stop. This is the
 *     greenfield "I just ran db init" case — the user hasn't written any
 *     tables yet. Throwing here would make `db init` feel unsafe to
 *     re-run as a discovery step.
 *   - File exists but declares no tables: print the "add a table" hint
 *     and stop before `generateMigration` throws its internal "does not
 *     define any tables" error.
 *
 * Any other error from `loadSchemaFile` (invalid export, bad syntax) is
 * allowed to propagate — that's a real authoring bug the user should see.
 */
async function preflightMigrate(
  paths: ReturnType<typeof databasePaths>,
  loadSchema: (schemaFile: string) => Promise<unknown>,
): Promise<{ ok: boolean }> {
  if (!existsSync(paths.schemaFile)) {
    console.log();
    console.log(warn("No config/database/schema.ts found yet."));
    console.log("Define your entities first, for example:");
    console.log();
    console.log("  // config/database/schema.ts");
    console.log(
      '  import { defineSchema } from "@databricks/appkit/database";',
    );
    console.log();
    console.log("  export default defineSchema(({ table, id, text }) => ({");
    console.log('    user: table("user", {');
    console.log("      id: id(),");
    console.log("      email: text().notNull(),");
    console.log("    }),");
    console.log("  }));");
    console.log();
    console.log("Then re-run `appkit db init`.");
    return { ok: false };
  }

  const schema = await loadSchema(paths.schemaFile);
  const tables =
    (schema as { $tables?: Record<string, unknown> } | null)?.$tables ?? {};
  if (Object.keys(tables).length === 0) {
    console.log();
    console.log(
      warn("config/database/schema.ts exists but defines no tables yet."),
    );
    console.log(
      "Add at least one table inside `defineSchema({ ... })` and re-run `appkit db init`.",
    );
    console.log();
    return { ok: false };
  }

  return { ok: true };
}

async function resolveSeedChoice(
  options: RunInitOptions,
  seedFile: string,
  interactive: boolean,
): Promise<boolean> {
  const seedExists = existsSync(seedFile);

  // `--no-seed`: honored verbatim regardless of the file.
  if (options.seed === false) return false;

  // `--seed` with no file: warn and skip instead of crashing downstream in
  // runSeed when it tries to `readFile(seedFile)`. The seed step is
  // optional; we'd rather complete `db init` successfully and let the user
  // create seed.sql later.
  if (options.seed === true && !seedExists) {
    console.log(
      warn(
        `seed.sql not found at ${path.relative(process.cwd(), seedFile)}; skipping seed.`,
      ),
    );
    return false;
  }

  // `--seed` with file: honor verbatim.
  if (options.seed === true) return true;

  // No explicit flag + no file: nothing to seed, silently skip.
  if (!seedExists) return false;

  // Non-interactive + file present: default to seed (matches prior behavior).
  if (!interactive) return true;

  const choice = await confirm({
    message: `Run ${path.basename(seedFile)} after migration?`,
    initialValue: true,
  });
  if (isCancel(choice)) throw new Error("Cancelled.");
  return Boolean(choice);
}

/* ============================================================ */
/* Spinner helper                                                */
/* ============================================================ */

/**
 * Run `fn` with a clack spinner that always closes — including when `fn`
 * throws. Without this wrapper a thrown error would leave the cursor hidden
 * and the spinner animating in the user's terminal until they reset it.
 *
 * `successMessage` may be a static string or a function of the resolved value
 * so call sites can include data from the result (e.g. "Found 3 branches").
 */
async function withSpinner<T>(
  startMessage: string,
  successMessage: string | ((value: T) => string),
  fn: () => Promise<T>,
): Promise<T> {
  const spin = spinner();
  spin.start(startMessage);
  try {
    const result = await fn();
    const finalMessage =
      typeof successMessage === "function"
        ? successMessage(result)
        : successMessage;
    spin.stop(finalMessage);
    return result;
  } catch (error) {
    spin.stop(`Failed: ${startMessage}`);
    throw error;
  }
}

/* ============================================================ */
/* Databricks CLI shellouts                                      */
/* ============================================================ */

/** Shape of every Databricks CLI invocation. Args do NOT include `databricks` itself. */
export type CliRunner = (args: string[]) => Promise<unknown>;

interface ProfileSummary {
  name: string;
  host: string;
}

interface ProjectSummary {
  name: string;
  displayName: string;
}

interface BranchSummary {
  /** Resource name as returned by Lakebase: `projects/foo/branches/main`. */
  name: string;
  /** Last path segment, used to address the branch in subsequent CLI calls. */
  id: string;
  isDefault: boolean;
}

interface EndpointSummary {
  name: string;
  host: string;
}

interface DatabaseSummary {
  name: string;
  postgresDatabase: string;
}

interface UserSummary {
  id: string;
  /** Stable, human-friendly identifier used to derive a deterministic branch slug. */
  principal: string;
  /** Postgres role name (typically the user's email). Goes straight to PGUSER. */
  userName: string;
}

/**
 * Default Databricks CLI runner: invokes the user's `databricks` binary and
 * parses the JSON response.
 *
 * `--output json` controls the *response* format and is orthogonal to the
 * `--json <body>` flag that some commands use to pass a *request* body. Both
 * may appear in the same invocation (e.g. `create-branch`).
 */
async function defaultDatabricksCli(args: string[]): Promise<unknown> {
  const fullArgs = [...args, "--output", "json"];
  let result: Awaited<ReturnType<typeof execa>>;
  try {
    result = await execa("databricks", fullArgs, { reject: false });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      throw new Error(
        "Databricks CLI not found on PATH. Install it from https://docs.databricks.com/aws/en/dev-tools/cli/install.",
      );
    }
    throw error;
  }
  if (result.exitCode !== 0) {
    const stderr = String(result.stderr ?? result.stdout ?? "").trim();
    throw new Error(`databricks ${args.join(" ")} failed: ${stderr}`);
  }
  const stdout = String(result.stdout ?? "").trim();
  if (stdout.length === 0) return null;
  try {
    return JSON.parse(stdout);
  } catch (parseError) {
    const preview = stdout.length > 200 ? `${stdout.slice(0, 200)}…` : stdout;
    throw new Error(
      `databricks ${args.join(" ")} returned invalid JSON: ${preview}`,
      { cause: parseError instanceof Error ? parseError : undefined },
    );
  }
}

async function listProfiles(cli: CliRunner): Promise<ProfileSummary[]> {
  const raw = (await cli(["auth", "profiles"])) as {
    profiles?: Array<{ name?: string; host?: string }>;
  } | null;
  const out: ProfileSummary[] = [];
  for (const p of raw?.profiles ?? []) {
    if (typeof p.name === "string" && typeof p.host === "string") {
      out.push({ name: p.name, host: p.host });
    }
  }
  return out;
}

async function getCurrentUser(
  cli: CliRunner,
  profile: string,
): Promise<UserSummary> {
  const raw = (await cli(["current-user", "me", "--profile", profile])) as {
    id?: string;
    userName?: string;
    displayName?: string;
    emails?: Array<{ value?: string; primary?: boolean }>;
  } | null;

  if (!raw?.id) {
    throw new Error(
      `databricks current-user me did not return an id for profile "${profile}".`,
    );
  }

  const email =
    raw.emails?.find((e) => e.primary)?.value ?? raw.emails?.[0]?.value;
  const userName = raw.userName ?? email ?? raw.displayName ?? "user";
  const principal = pickPrincipal({
    userName: raw.userName,
    displayName: raw.displayName,
    email,
  });

  return { id: raw.id, principal, userName };
}

async function listProjects(
  cli: CliRunner,
  profile: string,
): Promise<ProjectSummary[]> {
  const raw = (await cli([
    "postgres",
    "list-projects",
    "--profile",
    profile,
  ])) as Array<{ name?: string; status?: { display_name?: string } }> | null;
  const out: ProjectSummary[] = [];
  for (const p of raw ?? []) {
    if (typeof p.name === "string") {
      out.push({
        name: p.name,
        displayName: p.status?.display_name ?? p.name,
      });
    }
  }
  return out;
}

async function listBranches(
  cli: CliRunner,
  profile: string,
  project: string,
): Promise<BranchSummary[]> {
  const raw = (await cli([
    "postgres",
    "list-branches",
    project,
    "--profile",
    profile,
  ])) as Array<{ name?: string; status?: { default?: boolean } }> | null;
  const out: BranchSummary[] = [];
  for (const b of raw ?? []) {
    if (typeof b.name === "string") {
      out.push({
        name: b.name,
        id: b.name.split("/").pop() ?? b.name,
        isDefault: b.status?.default === true,
      });
    }
  }
  return out;
}

/**
 * Create a per-user dev branch by cloning the project's default branch.
 *
 * `no_expiry: true` is intentional for dev branches: `db init` cannot predict
 * how long the user will keep the branch around, and the alternative
 * (`expire_at`) would silently delete branches mid-development. Users who
 * want a TTL can `databricks postgres delete-branch` when they're done, or
 * pass an explicit body via `databricks postgres create-branch --json` by
 * hand.
 */
async function createBranch(
  cli: CliRunner,
  profile: string,
  project: string,
  branchId: string,
  sourceBranchId: string,
): Promise<{ name: string }> {
  const body = JSON.stringify({
    spec: {
      source_branch: `${project}/branches/${sourceBranchId}`,
      no_expiry: true,
    },
  });
  const raw = (await cli([
    "postgres",
    "create-branch",
    project,
    branchId,
    "--profile",
    profile,
    "--json",
    body,
  ])) as { name?: string } | null;
  if (!raw?.name) {
    throw new Error(
      `create-branch returned no name for ${project}/branches/${branchId}.`,
    );
  }
  return { name: raw.name };
}

/**
 * Resolve the read-write endpoint for a branch.
 *
 * `db init` always needs write access (to apply migrations or write rows),
 * so we explicitly require an `ENDPOINT_TYPE_READ_WRITE`. Falling back to
 * the first endpoint silently would let `setupDev` run a few statements
 * before failing with a confusing "permission denied" deep in pg.
 */
async function getEndpoint(
  cli: CliRunner,
  profile: string,
  branchName: string,
): Promise<EndpointSummary> {
  const raw = (await cli([
    "postgres",
    "list-endpoints",
    branchName,
    "--profile",
    profile,
  ])) as Array<{
    name?: string;
    status?: { endpoint_type?: string; hosts?: { host?: string } };
  }> | null;
  const endpoints = raw ?? [];
  const chosen = endpoints.find(
    (e) => e.status?.endpoint_type === "ENDPOINT_TYPE_READ_WRITE",
  );
  if (!chosen?.name || !chosen.status?.hosts?.host) {
    const found = endpoints
      .map((e) => e.status?.endpoint_type ?? "unknown")
      .join(", ");
    throw new Error(
      `No read-write endpoint on branch ${branchName}. db init requires write access. ` +
        `Found endpoint types: ${found || "none"}.`,
    );
  }
  return { name: chosen.name, host: chosen.status.hosts.host };
}

async function getDatabase(
  cli: CliRunner,
  profile: string,
  branchName: string,
): Promise<DatabaseSummary> {
  const raw = (await cli([
    "postgres",
    "list-databases",
    branchName,
    "--profile",
    profile,
  ])) as Array<{
    name?: string;
    status?: { postgres_database?: string };
  }> | null;
  const first = (raw ?? [])[0];
  if (!first?.name || !first.status?.postgres_database) {
    throw new Error(`No databases found on branch ${branchName}.`);
  }
  return {
    name: first.name,
    postgresDatabase: first.status.postgres_database,
  };
}

/* ============================================================ */
/* .env writer (line-oriented, preserves comments + foreign keys) */
/* ============================================================ */

const ENV_KEY_PATTERN = /^([A-Z][A-Z0-9_]*)=/;

function writeEnvKeys(envPath: string, updates: EnvUpdates): void {
  const remaining = new Map<string, string>();
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) remaining.set(key, value);
  }
  const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const lines = existing === "" ? [] : existing.split(/\r?\n/);
  // Drop a single trailing empty line so we don't double-newline before appending.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const out: string[] = [];
  for (const line of lines) {
    const match = ENV_KEY_PATTERN.exec(line);
    const key = match?.[1];
    if (key && remaining.has(key)) {
      out.push(`${key}=${remaining.get(key) ?? ""}`);
      remaining.delete(key);
    } else {
      out.push(line);
    }
  }
  for (const [key, value] of remaining) {
    out.push(`${key}=${value}`);
  }
  out.push("");
  writeFileSync(envPath, out.join("\n"), "utf8");
}

/* ============================================================ */
/* Pure helpers                                                  */
/* ============================================================ */

/**
 * Pick a stable, human-friendly identifier from the user-info payload.
 *
 * Order matters and is intentional:
 *   1. Email local-part — short, stable, almost always present for SSO users.
 *   2. userName — falls through for service principals that lack email but
 *      still have a workspace-scoped username.
 *   3. displayName — last-resort fallback for very minimal user records.
 *   4. Literal `"user"` — guarantees a non-empty string so we never emit a
 *      branch named `dev--abc123`.
 */
function pickPrincipal(input: {
  userName?: string;
  displayName?: string;
  email?: string;
}): string {
  const candidate = input.email ?? input.userName;
  if (candidate?.includes("@")) {
    const local = candidate.split("@")[0];
    if (local) return local;
  }
  return input.displayName ?? input.userName ?? "user";
}

const SLUG_MAX_LEN = 32;

export function slugifyPrincipal(principal: string): string {
  return principal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX_LEN)
    .replace(/-+$/g, "");
}

/**
 * 24-bit (6 hex char) prefix of a SHA-256 of the Databricks user id.
 *
 * This is a *naming* component, not a security primitive. Collision domain is
 * "users in the same Lakebase project", and the consequence of a collision is
 * "two users would share a dev branch" — Lakebase auth still applies, no data
 * leakage. Birthday-paradox at ~1k users is ~3% chance of any collision; the
 * trade-off vs. longer hashes is a more readable branch name.
 */
export function shortHash(id: string): string {
  return crypto.createHash("sha256").update(id).digest("hex").slice(0, 6);
}

export function deriveDevBranchName(user: {
  id: string;
  principal: string;
}): string {
  return `dev-${slugifyPrincipal(user.principal)}-${shortHash(user.id)}`;
}

function defaultIsInteractive(): boolean {
  return Boolean(process.stdin.isTTY);
}

/**
 * Probe whether the target schema already has tables. Used to suggest
 * `migrate` (empty schema → push schema.ts to DB) vs. `introspect` (populated
 * schema → pull DB into schema.ts) without forcing the user to pick `--from`.
 *
 * Counts via `pg_catalog.pg_tables`, which excludes views, materialized views,
 * foreign tables, and partitions — that matches the heuristic intent: we want
 * "ordinary tables a migration might create or conflict with".
 */
async function defaultProbeTableCount(schemaName: string): Promise<number> {
  const pool: LakebasePool | null = await openLakebasePool();
  if (!pool) {
    throw new Error("No Lakebase connection. Set LAKEBASE_ENDPOINT or PGHOST.");
  }
  try {
    const result = await pool.query<{ table_count: number | string }>(
      "SELECT count(*)::int AS table_count FROM pg_catalog.pg_tables WHERE schemaname = $1",
      [schemaName],
    );
    const value = result.rows[0]?.table_count ?? 0;
    return typeof value === "number" ? value : Number(value);
  } finally {
    await pool.end().catch(() => {
      /* swallow: do not mask the original error */
    });
  }
}

/* ============================================================ */
/* Commander wiring                                              */
/* ============================================================ */

export const initCommand = new Command("init")
  .description("One-command Lakebase database onboarding")
  .option("--profile <name>", "Databricks profile to use")
  .option("--project <name>", "Lakebase project resource name")
  .option(
    "--from <action>",
    "Setup action: migrate | introspect | reset (default: auto-detect)",
  )
  .option("--schema <name>", "Target Postgres schema (default: public)")
  .option(
    "--seed",
    "Run config/database/seed.sql after migration (migrate only)",
  )
  .option("--no-seed", "Skip seed.sql even if present (migrate only)")
  .option("--yes", "Run non-interactively; require flags for ambiguous choices")
  .action((opts) =>
    runCommandAction(() =>
      runInit({
        profile: opts.profile ? String(opts.profile) : undefined,
        project: opts.project ? String(opts.project) : undefined,
        from: opts.from as InitMode | undefined,
        schema: opts.schema ? String(opts.schema) : undefined,
        // Commander turns --no-seed into seed=false; --seed into seed=true; no
        // flag leaves seed undefined (so resolveSeedChoice can prompt or
        // default per `--yes`).
        seed: opts.seed === undefined ? undefined : Boolean(opts.seed),
        yes: Boolean(opts.yes),
      }),
    ),
  );
