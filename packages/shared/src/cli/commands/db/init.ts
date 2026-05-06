/**
 * `appkit db init` — one-command Lakebase onboarding.
 *
 * Always creates or reuses a per-user dev branch and writes `.env`. The
 * schema sync direction differs by mode:
 *   - migrate:    schema.ts → branch (generate + apply, optional seed).
 *   - introspect: branch → schema.ts (then verify).
 *   - reset:      drop all app tables, then migrate.
 *
 * Auto-detect picks `migrate` for empty schemas, `introspect` otherwise.
 * Pass `--from` to override.
 *
 * Phase helpers (pickWorkspace, resolveDevBranch, …) are testable via the
 * `RunInitDeps` injection point.
 */

import crypto from "node:crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  autocomplete,
  confirm,
  intro,
  isCancel,
  outro,
  select,
  spinner,
  text,
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
 * Schema sync direction. Names mirror the underlying CLI commands.
 * `reset` drops every app table then falls through to migrate — safe on
 * dev branches because they're per-user clones that `db init` can recreate.
 */
export type InitMode = "migrate" | "introspect" | "reset";

const INIT_MODES: readonly InitMode[] = [
  "migrate",
  "introspect",
  "reset",
] as const;

function isInitMode(value: string): value is InitMode {
  return (INIT_MODES as readonly string[]).includes(value);
}

export interface RunInitOptions {
  profile?: string;
  project?: string;
  from?: InitMode;
  schema?: string;
  seed?: boolean;
  /** Skip every confirmation prompt; refuse when a default is unavailable. */
  yes?: boolean;
  /** Print env-diff and mode, then stop. Use with `--yes` to preview a CI run. */
  dryRun?: boolean;
  /** Required with `--yes` for `--from reset`; otherwise the wipe refuses. */
  allowDestructive?: boolean;
  /** Override the project root used to resolve `.env` and `config/database/`. */
  cwd?: string;
}

export type EnvWriter = (envPath: string, updates: EnvUpdates) => void;

/** Injection points so tests can run `runInit` without touching Databricks, Lakebase, or `.env`. */
export interface RunInitDeps {
  databricksCli?: CliRunner;
  /** Probe used to auto-detect migrate vs introspect. */
  probeTableCount?: (schema: string) => Promise<number>;
  setupDev?: typeof setupDev;
  runIntrospect?: typeof runIntrospect;
  verifyDatabase?: typeof verifyDatabase;
  /** Lets tests skip the "file exists but declares no tables" preflight without real Drizzle tables. */
  loadSchemaFile?: (schemaFile: string) => Promise<unknown>;
  dropAllAppTables?: typeof dropAllAppTables;
  /** Defaults to file write + `process.env` mutation. */
  applyEnvUpdates?: EnvWriter;
  /** Defaults to `process.stdin.isTTY === true`. */
  isInteractive?: () => boolean;
}

/* ============================================================ */
/* Constants                                                     */
/* ============================================================ */

/**
 * Env keys this command owns; keys outside this list are preserved verbatim.
 * Increment-only — removing a key is breaking for apps already sourcing `.env`.
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

/** Switch from plain select to autocomplete once the choice list grows past this. */
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
  printEnvDiff(envPath, envUpdates, cwd);

  if (options.dryRun) {
    const mode = await resolveMode(options, fns.probeTableCount, interactive);
    console.log(bullet(`Mode (planned): ${mode}`));
    console.log(
      warn("Dry run: .env not written, no tables touched, no flow delegated."),
    );
    outro("Dry run complete.");
    return;
  }

  fns.applyEnvUpdates(envPath, envUpdates);
  console.log(check(`.env updated (${path.relative(cwd, envPath)})`));

  const mode = await resolveMode(options, fns.probeTableCount, interactive);
  if (mode === "reset") {
    await confirmReset(branch.fullName, options, interactive);
  }
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
 * Pick profile + project and return them with the profile's host URL.
 * Combined so we list profiles once instead of twice (prompt + host lookup).
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
  // Long lists benefit from type-to-filter; short lists don't.
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
  /** Short id used in CLI commands (`dev-{slug}-{hash}`). */
  id: string;
  /** Lakebase resource name (`projects/foo/branches/dev-...`). */
  fullName: string;
  /** True when created on this run; false when reused. */
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

/** Fetch endpoint + database in parallel; each is a ~500ms CLI shellout. */
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
 * Persist to disk and mirror into `process.env` so follow-on phases
 * (`probeTableCount`, `setupDev`, …) see the new values without re-sourcing.
 */
function defaultApplyEnvUpdates(envPath: string, updates: EnvUpdates): void {
  // Snapshot the prior `.env` to `.env.bak.<ms>` (chmod 0600 in case it had secrets).
  if (existsSync(envPath)) {
    try {
      const previous = readFileSync(envPath, "utf8");
      const bakPath = `${envPath}.bak.${Date.now()}`;
      writeFileSync(bakPath, previous, { encoding: "utf8", mode: 0o600 });
      try {
        chmodSync(bakPath, 0o600);
      } catch {}
    } catch (err) {
      // Non-fatal: warn so the user can back up manually.
      console.warn(
        warn(
          `Could not write .env.bak (${(err as Error).message}); proceeding anyway`,
        ),
      );
    }
  }
  writeEnvKeys(envPath, updates);
  for (const key of OWNED_ENV_KEYS) {
    const value = updates[key];
    if (value !== undefined) {
      process.env[key] = value;
    }
  }
}

/**
 * Print a per-key ADD/CHANGE/KEEP plan so the user can catch typos before
 * the write lands. Owned-key values are shown verbatim (none are secrets).
 */
function printEnvDiff(envPath: string, updates: EnvUpdates, cwd: string): void {
  const existing: Partial<Record<OwnedEnvKey, string>> = {};
  if (existsSync(envPath)) {
    const previous = readFileSync(envPath, "utf8");
    for (const line of previous.split(/\r?\n/)) {
      const match = ENV_KEY_PATTERN.exec(line);
      const key = match?.[1];
      if (!key) continue;
      // Last-wins matches dotenv loader semantics; previous KEEP/CHANGE diff
      // would otherwise contradict what the runtime ends up with.
      if ((OWNED_ENV_KEYS as readonly string[]).includes(key)) {
        existing[key as OwnedEnvKey] = parseEnvValue(line);
      }
    }
  }

  console.log(bullet(`.env plan (${path.relative(cwd, envPath)})`));
  for (const key of OWNED_ENV_KEYS) {
    const next = updates[key];
    if (next === undefined) continue;
    const prev = existing[key];
    const tag = prev === undefined ? "ADD" : prev === next ? "KEEP" : "CHANGE";
    console.log(`    ${tag.padEnd(7)} ${key}=${next}`);
  }
}

/**
 * Require the user to type the branch name before reset drops every table.
 * Under `--yes`, the typed-name check is replaced by `--allow-destructive`
 * so a fat-fingered command can't silently wipe a branch.
 */
async function confirmReset(
  branch: string,
  options: RunInitOptions,
  interactive: boolean,
): Promise<void> {
  if (options.yes) {
    if (!options.allowDestructive) {
      throw new Error(
        `Reset refused: --from reset --yes requires --allow-destructive (would drop every table in "${branch}").`,
      );
    }
    return;
  }
  if (!interactive) {
    throw new Error(
      `Reset refused: non-interactive shell. Re-run with --yes --allow-destructive to confirm dropping every table in "${branch}".`,
    );
  }
  console.log();
  console.log(warn(`Reset will DROP every table in branch "${branch}".`));
  const typed = await text({
    message: `Type the branch name (${branch}) to confirm`,
    placeholder: branch,
  });
  if (isCancel(typed) || String(typed).trim() !== branch) {
    throw new Error("Reset aborted: branch name did not match.");
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
  // Explicit --from short-circuits the probe; no auto-pivot.
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
      await fns.dropAllAppTables({
        schema: schemaName,
        allowDestructive: true,
      });
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
 * Soft-fail with guidance (not a stack trace) when schema.ts is missing or
 * declares no tables. Real authoring bugs (bad syntax, invalid export) still
 * propagate.
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

  if (options.seed === false) return false;

  // `--seed` without seed.sql: warn and skip rather than crash in runSeed.
  if (options.seed === true && !seedExists) {
    console.log(
      warn(
        `seed.sql not found at ${path.relative(process.cwd(), seedFile)}; skipping seed.`,
      ),
    );
    return false;
  }

  if (options.seed === true) return true;
  if (!seedExists) return false;
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
 * Run `fn` with a clack spinner that always closes (even on throw), so a
 * crash can't leave the cursor hidden and the spinner animating.
 * `successMessage` may be a function of the resolved value.
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

/** Shape of every Databricks CLI invocation. Args exclude the `databricks` binary. */
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
  /** Lakebase resource name (`projects/foo/branches/main`). */
  name: string;
  /** Last path segment; used to address the branch in CLI calls. */
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
  /** Stable identifier used to derive the dev branch slug. */
  principal: string;
  /** Postgres role name (typically the email); written verbatim to PGUSER. */
  userName: string;
}

/**
 * Invoke the user's `databricks` binary and parse the JSON response.
 *
 * `--output json` (response format) is independent of `--json <body>`
 * (request body); both can appear in the same call (e.g. `create-branch`).
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
 * Clone the project's default branch into a per-user dev branch.
 * `no_expiry: true` avoids silent mid-development deletion; users who want
 * a TTL can `databricks postgres delete-branch` manually.
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
 * Resolve the read-write endpoint. We require `ENDPOINT_TYPE_READ_WRITE`
 * explicitly so a silent fallback to a read-only endpoint can't surface as
 * a confusing pg "permission denied" mid-migration.
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

/**
 * Read a `.env` line's value, stripping surrounding double or single quotes
 * and trailing carriage returns (Windows). Used by `printEnvDiff` so re-runs
 * don't show spurious "CHANGE" diffs on hand-quoted values or CRLF files.
 */
function parseEnvValue(line: string): string {
  let value = line.slice(line.indexOf("=") + 1);
  if (value.endsWith("\r")) value = value.slice(0, -1);
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value;
}

function writeEnvKeys(envPath: string, updates: EnvUpdates): void {
  const remaining = new Map<string, string>();
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) remaining.set(key, value);
  }
  const existing = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const lines = existing === "" ? [] : existing.split(/\r?\n/);
  // Drop trailing empty line to avoid double-newline on append.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  // Track which keys we've written so duplicate KEY= lines collapse — dotenv
  // loads the last occurrence; if we replace only the first, the runtime gets
  // a different value than the diff promised.
  const written = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const match = ENV_KEY_PATTERN.exec(line);
    const key = match?.[1];
    if (key && remaining.has(key)) {
      if (!written.has(key)) {
        out.push(`${key}=${remaining.get(key) ?? ""}`);
        written.add(key);
        remaining.delete(key);
      }
      // Skip subsequent lines for the same owned key (dedupe).
    } else if (key && written.has(key)) {
      // Drop duplicate of an owned key we already wrote.
    } else {
      out.push(line);
    }
  }
  for (const [key, value] of remaining) {
    out.push(`${key}=${value}`);
  }
  out.push("");
  // tmp + rename: POSIX-atomic so Ctrl-C can't truncate `.env`.
  const tmpPath = `${envPath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmpPath, out.join("\n"), { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(tmpPath, 0o600);
  } catch {}
  renameSync(tmpPath, envPath);
}

/* ============================================================ */
/* Pure helpers                                                  */
/* ============================================================ */

/**
 * Pick a stable identifier in this order: email local-part → userName →
 * displayName → `"user"`. The literal fallback guarantees a non-empty slug
 * (no `dev--abc123`).
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
 * 8 hex chars of SHA-256(user id). Naming only, not security: a collision
 * just means two users share a dev branch (Lakebase auth still applies).
 * 1-in-4B is enough for any realistic team size.
 */
export function shortHash(id: string): string {
  return crypto.createHash("sha256").update(id).digest("hex").slice(0, 8);
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
 * Count tables in the target schema to suggest migrate (empty) vs introspect
 * (populated). Uses `pg_catalog.pg_tables` to exclude views, materialized
 * views, foreign tables, and partitions — only ordinary tables count.
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
      /* swallow so we don't mask the original error */
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
    "Setup action: migrate | introspect | reset — `reset` is destructive (drops every app table); default auto-detects",
  )
  .option("--schema <name>", "Target Postgres schema (default: public)")
  .option(
    "--seed",
    "Run config/database/seed.sql after migration (no-op when seed.sql is missing; migrate only)",
  )
  .option("--no-seed", "Skip seed.sql even if present (migrate only)")
  .option("--yes", "Run non-interactively; require flags for ambiguous choices")
  .option(
    "--dry-run",
    "Print env-diff and resolved mode without writing .env or running the flow (still requires a Lakebase connection)",
  )
  .option(
    "--allow-destructive",
    "Required with --yes for --from reset (otherwise the wipe refuses)",
  )
  .action((opts) =>
    runCommandAction(() =>
      runInit({
        profile: opts.profile ? String(opts.profile) : undefined,
        project: opts.project ? String(opts.project) : undefined,
        from: parseFromOption(opts.from),
        schema: opts.schema ? String(opts.schema) : undefined,
        // Commander: --no-seed → false, --seed → true, absent → undefined
        // (so resolveSeedChoice can prompt or default per `--yes`).
        seed: opts.seed === undefined ? undefined : Boolean(opts.seed),
        yes: Boolean(opts.yes),
        dryRun: Boolean(opts.dryRun),
        allowDestructive: Boolean(opts.allowDestructive),
      }),
    ),
  );

/**
 * Validate `--from <action>` against the union so a typo (e.g. `--from forced`)
 * fails loudly here rather than slipping into `runInit`.
 */
function parseFromOption(value: unknown): InitMode | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const str = String(value);
  if (isInitMode(str)) return str;
  throw new Error(
    `Invalid --from value: "${str}". Expected one of: ${INIT_MODES.join(", ")}.`,
  );
}
