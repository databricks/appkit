import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type CliRunner,
  deriveDevBranchName,
  type EnvUpdates,
  initCommand,
  OWNED_ENV_KEYS,
  type RunInitDeps,
  type RunInitOptions,
  runInit,
  shortHash,
  slugifyPrincipal,
} from "../init";

/* ============================================================ */
/* Typed fixtures                                                */
/* ============================================================ */

interface FakeProfilesResponse {
  profiles: Array<{ name: string; host: string }>;
}

interface FakeUserResponse {
  id: string;
  userName?: string;
  displayName?: string;
  emails?: Array<{ value: string; primary?: boolean }>;
}

interface FakeProjectResponse {
  name: string;
  status?: { display_name?: string };
}

interface FakeBranchResponse {
  name: string;
  status?: { default?: boolean };
}

interface FakeEndpointResponse {
  name: string;
  status?: { endpoint_type?: string; hosts?: { host?: string } };
}

interface FakeDatabaseResponse {
  name: string;
  status?: { postgres_database?: string };
}

interface FakeCliResponses {
  profiles?: FakeProfilesResponse;
  projects?: FakeProjectResponse[];
  user?: FakeUserResponse;
  branches?: FakeBranchResponse[];
  createBranch?: { name: string };
  endpoints?: FakeEndpointResponse[];
  databases?: FakeDatabaseResponse[];
}

const DEFAULT_PROFILES: FakeProfilesResponse = {
  profiles: [{ name: "DEFAULT", host: "https://h.example" }],
};

const DEFAULT_USER: FakeUserResponse = {
  id: "u-1",
  userName: "alice@example.com",
  displayName: "Alice",
  emails: [{ value: "alice@example.com", primary: true }],
};

const DEFAULT_PROJECTS: FakeProjectResponse[] = [
  { name: "projects/foo", status: { display_name: "Foo" } },
];

const DEFAULT_BRANCHES: FakeBranchResponse[] = [
  { name: "projects/foo/branches/main", status: { default: true } },
];

const DEFAULT_ENDPOINTS: FakeEndpointResponse[] = [
  {
    name: "projects/foo/branches/dev-alice-XXXXXX/endpoints/primary",
    status: {
      endpoint_type: "ENDPOINT_TYPE_READ_WRITE",
      hosts: { host: "ep.example" },
    },
  },
];

const DEFAULT_DATABASES: FakeDatabaseResponse[] = [
  {
    name: "projects/foo/branches/dev-alice-XXXXXX/databases/db-X",
    status: { postgres_database: "databricks_postgres" },
  },
];

const DEFAULT_CREATE_BRANCH = {
  name: "projects/foo/branches/dev-alice-XXXXXX",
};

/**
 * Fake Databricks CLI runner that returns a canned response per subcommand.
 * Typed so a fixture typo (e.g. `endpoint_typee`) is a compile error.
 */
function fakeCli(responses: FakeCliResponses = {}) {
  const tracked = vi.fn(async (args: string[]): Promise<unknown> => {
    const joined = args.join(" ");
    if (joined.startsWith("auth profiles")) {
      return responses.profiles ?? DEFAULT_PROFILES;
    }
    if (joined.startsWith("current-user me")) {
      return responses.user ?? DEFAULT_USER;
    }
    if (joined.startsWith("postgres list-projects")) {
      return responses.projects ?? DEFAULT_PROJECTS;
    }
    if (joined.startsWith("postgres list-branches")) {
      return responses.branches ?? DEFAULT_BRANCHES;
    }
    if (joined.startsWith("postgres create-branch")) {
      return responses.createBranch ?? DEFAULT_CREATE_BRANCH;
    }
    if (joined.startsWith("postgres list-endpoints")) {
      return responses.endpoints ?? DEFAULT_ENDPOINTS;
    }
    if (joined.startsWith("postgres list-databases")) {
      return responses.databases ?? DEFAULT_DATABASES;
    }
    throw new Error(`Unexpected CLI args: ${joined}`);
  });
  return tracked as ReturnType<typeof vi.fn> & CliRunner;
}

/* ============================================================ */
/* Test environment helpers                                      */
/* ============================================================ */

interface TestEnv {
  cwd: string;
  envPath: string;
  cleanup: () => void;
}

function mkTempProject(
  opts: { schema?: boolean; seed?: boolean } = {},
): TestEnv {
  const cwd = mkdtempSync(path.join(tmpdir(), "appkit-init-"));
  // databasePaths() walks up from cwd looking for package.json.
  writeFileSync(path.join(cwd, "package.json"), '{"name":"fixture"}');
  if (opts.schema) {
    const configDir = path.join(cwd, "config", "database");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(path.join(configDir, "schema.ts"), "export default {};\n");
    if (opts.seed) {
      writeFileSync(
        path.join(configDir, "seed.sql"),
        "INSERT INTO foo VALUES (1) ON CONFLICT DO NOTHING;\n",
      );
    }
  }
  return {
    cwd,
    envPath: path.join(cwd, ".env"),
    cleanup: () => rmSync(cwd, { recursive: true, force: true }),
  };
}

let testEnv: TestEnv | undefined;
let envSnapshot: Record<string, string | undefined>;

beforeEach(() => {
  // Snapshot OWNED keys so the default writer can't bleed state between tests.
  envSnapshot = Object.fromEntries(
    OWNED_ENV_KEYS.map((key) => [key, process.env[key]]),
  );
});

afterEach(() => {
  for (const [key, value] of Object.entries(envSnapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  testEnv?.cleanup();
  testEnv = undefined;
  vi.unstubAllEnvs();
});

/**
 * Build deps with sane defaults: env-update collector, interactive=true, and
 * a `loadSchemaFile` fake with non-empty `$tables` so the migrate preflight
 * passes. Tests that exercise either path override the relevant field.
 */
function makeDeps(
  overrides: Partial<RunInitDeps> & {
    tableCount?: number;
    interactive?: boolean;
  } = {},
): RunInitDeps & {
  setupDev: ReturnType<typeof vi.fn>;
  runIntrospect: ReturnType<typeof vi.fn>;
  verifyDatabase: ReturnType<typeof vi.fn>;
  loadSchemaFile: ReturnType<typeof vi.fn>;
  dropAllAppTables: ReturnType<typeof vi.fn>;
  applyEnvUpdates: ReturnType<typeof vi.fn>;
  capturedEnv: { path?: string; updates?: EnvUpdates };
} {
  const tableCount = overrides.tableCount ?? 0;
  const captured: { path?: string; updates?: EnvUpdates } = {};
  const applyEnvUpdates =
    overrides.applyEnvUpdates ??
    vi.fn((envPath: string, updates: EnvUpdates) => {
      captured.path = envPath;
      captured.updates = updates;
    });
  return {
    databricksCli: overrides.databricksCli ?? fakeCli(),
    probeTableCount: overrides.probeTableCount ?? vi.fn(async () => tableCount),
    setupDev:
      (overrides.setupDev as ReturnType<typeof vi.fn>) ?? vi.fn(async () => {}),
    runIntrospect:
      (overrides.runIntrospect as ReturnType<typeof vi.fn>) ??
      vi.fn(async () => {}),
    verifyDatabase:
      (overrides.verifyDatabase as ReturnType<typeof vi.fn>) ??
      vi.fn(async () => {}),
    loadSchemaFile:
      (overrides.loadSchemaFile as ReturnType<typeof vi.fn>) ??
      vi.fn(async () => ({ $drizzle: {}, $tables: { cases: {} } })),
    dropAllAppTables:
      (overrides.dropAllAppTables as ReturnType<typeof vi.fn>) ??
      vi.fn(async () => {}),
    applyEnvUpdates: applyEnvUpdates as ReturnType<typeof vi.fn>,
    isInteractive:
      overrides.isInteractive ??
      (() =>
        overrides.interactive === undefined ? true : overrides.interactive),
    capturedEnv: captured,
  };
}

function scriptedOptions(extra: Partial<RunInitOptions> = {}): RunInitOptions {
  // Pass every flag that would otherwise prompt, so tests never render @clack
  // on non-TTY stdin and stay deterministic.
  return {
    profile: "DEFAULT",
    project: "projects/foo",
    from: "migrate",
    schema: "public",
    seed: false,
    cwd: testEnv?.cwd,
    ...extra,
  };
}

/* ============================================================ */
/* Pure helpers                                                  */
/* ============================================================ */

describe("slugifyPrincipal", () => {
  test.each([
    ["jane.doe", "jane-doe"],
    ["Alice Smith", "alice-smith"],
    ["a".repeat(64), "a".repeat(32)],
    ["---weird---", "weird"],
    ["", ""],
  ])("slugifies %j to %j", (input, expected) => {
    expect(slugifyPrincipal(input)).toBe(expected);
  });
});

describe("shortHash", () => {
  test("is deterministic and 8 hex chars", () => {
    expect(shortHash("u-1")).toBe(shortHash("u-1"));
    expect(shortHash("u-1")).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("deriveDevBranchName", () => {
  test("produces dev-{slug}-{hash} within Lakebase 63-char budget", () => {
    const name = deriveDevBranchName({
      id: "u-9",
      principal: "a".repeat(200),
    });
    expect(name).toMatch(/^dev-a{32}-[0-9a-f]{8}$/);
    expect(name.length).toBeLessThanOrEqual(63);
  });
});

describe("OWNED_ENV_KEYS", () => {
  test("matches the eight keys documented in the JSDoc", () => {
    expect(OWNED_ENV_KEYS).toEqual([
      "DATABRICKS_HOST",
      "DATABRICKS_CONFIG_PROFILE",
      "LAKEBASE_ENDPOINT",
      "PGHOST",
      "PGDATABASE",
      "PGUSER",
      "PGPORT",
      "PGSSLMODE",
    ]);
  });
});

/* ============================================================ */
/* Commander wiring                                              */
/* ============================================================ */

describe("initCommand", () => {
  test("is registered as 'init' with the expected flags", () => {
    expect(initCommand.name()).toBe("init");
    const flags = initCommand.options.map((opt) => opt.flags);
    expect(flags).toEqual(
      expect.arrayContaining([
        "--profile <name>",
        "--project <name>",
        "--from <action>",
        "--schema <name>",
        "--seed",
        "--no-seed",
        "--yes",
      ]),
    );
  });

  test("commander parses --no-seed as seed=false; --seed as true; absent as undefined", async () => {
    // Guards against a future Commander upgrade silently changing this.
    // Assert on opts() directly so we don't have to mock all of runInit.
    const cases: Array<[string[], boolean | undefined]> = [
      [[], undefined],
      [["--seed"], true],
      [["--no-seed"], false],
    ];
    for (const [argv, expected] of cases) {
      const cmd = new Command("init").option("--seed").option("--no-seed");
      cmd.parse(["node", "init", ...argv], { from: "node" });
      expect(cmd.opts().seed).toBe(expected);
    }
  });
});

/* ============================================================ */
/* runInit orchestration                                         */
/* ============================================================ */

describe("runInit — migrate flow", () => {
  test("writes .env and calls setupDev with seed=false", async () => {
    testEnv = mkTempProject({ schema: true });

    const deps = makeDeps({ tableCount: 0 });
    await runInit(scriptedOptions({ from: "migrate", seed: false }), deps);

    expect(deps.setupDev).toHaveBeenCalledWith({
      name: "init",
      seed: false,
      force: false,
    });
    expect(deps.runIntrospect).not.toHaveBeenCalled();
    expect(deps.verifyDatabase).not.toHaveBeenCalled();

    expect(deps.capturedEnv.path).toBe(testEnv.envPath);
    expect(deps.capturedEnv.updates).toEqual({
      DATABRICKS_HOST: "https://h.example",
      DATABRICKS_CONFIG_PROFILE: "DEFAULT",
      LAKEBASE_ENDPOINT:
        "projects/foo/branches/dev-alice-XXXXXX/endpoints/primary",
      PGHOST: "ep.example",
      PGDATABASE: "databricks_postgres",
      PGUSER: "alice@example.com",
      PGPORT: "5432",
      PGSSLMODE: "require",
    });
  });

  test("soft-fails gracefully when config/database/schema.ts is missing", async () => {
    // Used to throw; now prints a starter snippet so `db init` is safe to re-run.
    testEnv = mkTempProject({ schema: false });

    const deps = makeDeps({ tableCount: 0 });
    await expect(
      runInit(scriptedOptions({ from: "migrate" }), deps),
    ).resolves.toBeUndefined();
    expect(deps.setupDev).not.toHaveBeenCalled();
    expect(deps.loadSchemaFile).not.toHaveBeenCalled();
  });

  test("soft-fails gracefully when schema.ts defines no tables", async () => {
    testEnv = mkTempProject({ schema: true });
    const deps = makeDeps({
      loadSchemaFile: vi.fn(async () => ({ $drizzle: {}, $tables: {} })),
    });

    await runInit(scriptedOptions({ from: "migrate", seed: false }), deps);

    expect(deps.setupDev).not.toHaveBeenCalled();
  });

  test("explicit --from migrate does NOT auto-pivot when schema is populated", async () => {
    testEnv = mkTempProject({ schema: true });

    const deps = makeDeps({ tableCount: 99 });
    await runInit(scriptedOptions({ from: "migrate", seed: false }), deps);

    expect(deps.setupDev).toHaveBeenCalled();
    expect(deps.runIntrospect).not.toHaveBeenCalled();
  });
});

describe("runInit — reset flow", () => {
  test("drops all tables then delegates to setupDev", async () => {
    testEnv = mkTempProject({ schema: true });

    const deps = makeDeps({});
    // `--yes` skips the typed-branch confirm (same flag CI uses).
    await runInit(
      scriptedOptions({
        from: "reset",
        seed: false,
        yes: true,
        allowDestructive: true,
      }),
      deps,
    );

    expect(deps.dropAllAppTables).toHaveBeenCalledWith({
      schema: "public",
      allowDestructive: true,
    });
    expect(deps.setupDev).toHaveBeenCalledWith({
      name: "init",
      seed: false,
      force: false,
    });
    // dropAllAppTables MUST precede setupDev: we don't migrate over stale tables.
    const dropOrder = deps.dropAllAppTables.mock.invocationCallOrder[0];
    const setupOrder = deps.setupDev.mock.invocationCallOrder[0];
    expect(dropOrder).toBeLessThan(setupOrder);
  });

  test("reset honors --schema for the target pg schema", async () => {
    testEnv = mkTempProject({ schema: true });

    const deps = makeDeps({});
    await runInit(
      scriptedOptions({
        from: "reset",
        schema: "app",
        seed: false,
        yes: true,
        allowDestructive: true,
      }),
      deps,
    );

    expect(deps.dropAllAppTables).toHaveBeenCalledWith({
      schema: "app",
      allowDestructive: true,
    });
  });

  test("reset short-circuits on missing schema.ts (does NOT drop tables)", async () => {
    testEnv = mkTempProject({ schema: false });

    const deps = makeDeps({});
    await runInit(
      scriptedOptions({ from: "reset", yes: true, allowDestructive: true }),
      deps,
    );

    expect(deps.dropAllAppTables).not.toHaveBeenCalled();
    expect(deps.setupDev).not.toHaveBeenCalled();
  });

  test("reset short-circuits on empty $tables (does NOT drop tables)", async () => {
    testEnv = mkTempProject({ schema: true });

    const deps = makeDeps({
      loadSchemaFile: vi.fn(async () => ({ $drizzle: {}, $tables: {} })),
    });
    await runInit(
      scriptedOptions({
        from: "reset",
        seed: false,
        yes: true,
        allowDestructive: true,
      }),
      deps,
    );

    expect(deps.dropAllAppTables).not.toHaveBeenCalled();
    expect(deps.setupDev).not.toHaveBeenCalled();
  });
});

describe("runInit — dry-run", () => {
  test("dry-run skips applyEnvUpdates and the migrate flow", async () => {
    testEnv = mkTempProject({ schema: true });

    const deps = makeDeps({});
    await runInit(
      scriptedOptions({ from: "migrate", seed: false, dryRun: true }),
      deps,
    );

    expect(deps.applyEnvUpdates).not.toHaveBeenCalled();
    expect(deps.setupDev).not.toHaveBeenCalled();
    expect(deps.runIntrospect).not.toHaveBeenCalled();
  });
});

describe("runInit — seed gate", () => {
  test("--seed with missing seed.sql warns and skips instead of crashing", async () => {
    // No seed.sql on disk, but caller passes --seed=true.
    testEnv = mkTempProject({ schema: true, seed: false });

    const deps = makeDeps({});
    await runInit(scriptedOptions({ from: "migrate", seed: true }), deps);

    expect(deps.setupDev).toHaveBeenCalledWith({
      name: "init",
      seed: false,
      force: false,
    });
  });

  test("--seed with existing seed.sql passes seed=true through", async () => {
    testEnv = mkTempProject({ schema: true, seed: true });

    const deps = makeDeps({});
    await runInit(scriptedOptions({ from: "migrate", seed: true }), deps);

    expect(deps.setupDev).toHaveBeenCalledWith({
      name: "init",
      seed: true,
      force: false,
    });
  });

  test("no --seed flag + no seed.sql on disk: seed=false, no crash", async () => {
    testEnv = mkTempProject({ schema: true, seed: false });

    const deps = makeDeps({});
    // scriptedOptions defaults seed=false; strip it to test "absent" path.
    const opts = scriptedOptions({ from: "migrate" });
    delete (opts as { seed?: unknown }).seed;
    await runInit(opts, deps);

    expect(deps.setupDev).toHaveBeenCalledWith({
      name: "init",
      seed: false,
      force: false,
    });
  });
});

describe("runInit — introspect flow", () => {
  test("calls runIntrospect then verifyDatabase, no setupDev", async () => {
    testEnv = mkTempProject();

    const deps = makeDeps({ tableCount: 7 });
    await runInit(scriptedOptions({ from: "introspect" }), deps);

    expect(deps.runIntrospect).toHaveBeenCalledWith({ schema: "public" });
    expect(deps.verifyDatabase).toHaveBeenCalledWith({});
    expect(deps.setupDev).not.toHaveBeenCalled();
  });
});

describe("runInit — branch lifecycle", () => {
  test("reuses existing dev branch when present", async () => {
    testEnv = mkTempProject({ schema: true });

    const branchName = `projects/foo/branches/${deriveDevBranchName({
      id: DEFAULT_USER.id,
      principal: "alice",
    })}`;
    const cli = fakeCli({
      branches: [
        { name: "projects/foo/branches/main", status: { default: true } },
        { name: branchName, status: { default: false } },
      ],
    });
    const deps = makeDeps({ databricksCli: cli, tableCount: 0 });

    await runInit(scriptedOptions({ from: "migrate", seed: false }), deps);

    const allCalls = cli.mock.calls.map((c) => (c[0] as string[]).join(" "));
    expect(allCalls.some((c) => c.startsWith("postgres create-branch"))).toBe(
      false,
    );
    expect(deps.setupDev).toHaveBeenCalled();
  });

  test("creates dev branch from project's default when missing", async () => {
    testEnv = mkTempProject({ schema: true });

    const cli = fakeCli();
    const deps = makeDeps({ databricksCli: cli, tableCount: 0 });
    await runInit(scriptedOptions({ from: "migrate", seed: false }), deps);

    const createCall = cli.mock.calls.find((c) =>
      (c[0] as string[]).join(" ").startsWith("postgres create-branch"),
    );
    expect(createCall).toBeDefined();
    const argsArr = createCall?.[0] as string[];
    const jsonBody = argsArr[argsArr.indexOf("--json") + 1];
    expect(JSON.parse(jsonBody)).toMatchObject({
      spec: {
        source_branch: "projects/foo/branches/main",
        no_expiry: true,
      },
    });
  });

  test("throws when project has no default branch to clone from", async () => {
    testEnv = mkTempProject({ schema: true });

    const deps = makeDeps({
      databricksCli: fakeCli({ branches: [] }),
      tableCount: 0,
    });

    await expect(
      runInit(scriptedOptions({ from: "migrate" }), deps),
    ).rejects.toThrow(/no default branch to clone from/);
  });
});

describe("runInit — endpoint enforcement", () => {
  test("rejects when no read-write endpoint exists", async () => {
    testEnv = mkTempProject({ schema: true });

    const cli = fakeCli({
      endpoints: [
        {
          name: "projects/foo/branches/main/endpoints/replica",
          status: {
            endpoint_type: "ENDPOINT_TYPE_READ_ONLY",
            hosts: { host: "ro.example" },
          },
        },
      ],
    });
    const deps = makeDeps({ databricksCli: cli, tableCount: 0 });

    await expect(
      runInit(scriptedOptions({ from: "migrate" }), deps),
    ).rejects.toThrow(/No read-write endpoint/);
  });
});

describe("runInit — env writer", () => {
  test("preserves non-allow-list keys in .env on rewrite", async () => {
    testEnv = mkTempProject({ schema: true });
    writeFileSync(
      testEnv.envPath,
      [
        "# project secrets",
        "OPENAI_API_KEY=sk-secret",
        "",
        "PGHOST=stale-value",
        "# trailing comment",
        "",
      ].join("\n"),
      "utf8",
    );

    // No override → exercise the real file-path writer.
    const deps = makeDeps({ tableCount: 0 });
    deps.applyEnvUpdates = undefined as unknown as ReturnType<typeof vi.fn>;
    await runInit(scriptedOptions({ from: "migrate", seed: false }), {
      databricksCli: deps.databricksCli,
      probeTableCount: deps.probeTableCount,
      setupDev: deps.setupDev,
      runIntrospect: deps.runIntrospect,
      verifyDatabase: deps.verifyDatabase,
      loadSchemaFile: deps.loadSchemaFile,
      dropAllAppTables: deps.dropAllAppTables,
      isInteractive: deps.isInteractive,
    });

    const env = readFileSync(testEnv.envPath, "utf8");
    expect(env).toContain("# project secrets");
    expect(env).toContain("OPENAI_API_KEY=sk-secret");
    expect(env).toContain("# trailing comment");
    expect(env).toContain("PGHOST=ep.example");
    expect(env).not.toContain("PGHOST=stale-value");
  });

  test("default writer mirrors values into process.env", async () => {
    testEnv = mkTempProject({ schema: true });

    const deps = makeDeps({ tableCount: 0 });
    deps.applyEnvUpdates = undefined as unknown as ReturnType<typeof vi.fn>;
    await runInit(scriptedOptions({ from: "migrate", seed: false }), {
      databricksCli: deps.databricksCli,
      probeTableCount: deps.probeTableCount,
      setupDev: deps.setupDev,
      runIntrospect: deps.runIntrospect,
      verifyDatabase: deps.verifyDatabase,
      loadSchemaFile: deps.loadSchemaFile,
      dropAllAppTables: deps.dropAllAppTables,
      isInteractive: deps.isInteractive,
    });

    expect(process.env.PGHOST).toBe("ep.example");
    expect(process.env.PGDATABASE).toBe("databricks_postgres");
    expect(process.env.DATABRICKS_CONFIG_PROFILE).toBe("DEFAULT");
  });
});

describe("runInit — non-interactive (--yes)", () => {
  test("auto-detected mode is honored when probe succeeds", async () => {
    testEnv = mkTempProject({ schema: true });
    const deps = makeDeps({ tableCount: 0, interactive: false });
    await runInit(
      {
        cwd: testEnv.cwd,
        profile: "DEFAULT",
        project: "projects/foo",
        seed: false,
        yes: true,
      },
      deps,
    );

    expect(deps.setupDev).toHaveBeenCalledWith({
      name: "init",
      seed: false,
      force: false,
    });
  });

  test("errors with actionable message when probe fails and --from is absent", async () => {
    testEnv = mkTempProject({ schema: true });
    const deps = makeDeps({
      probeTableCount: vi.fn(async () => {
        throw new Error("connection refused");
      }),
      interactive: false,
    });

    await expect(
      runInit(
        {
          cwd: testEnv.cwd,
          profile: "DEFAULT",
          project: "projects/foo",
          yes: true,
        },
        deps,
      ),
    ).rejects.toThrow(/Could not auto-detect setup mode/);
  });

  test("errors when --profile is absent and multiple profiles exist", async () => {
    testEnv = mkTempProject({ schema: true });
    const cli = fakeCli({
      profiles: {
        profiles: [
          { name: "DEFAULT", host: "https://h.example" },
          { name: "PROD", host: "https://p.example" },
        ],
      },
    });
    const deps = makeDeps({ databricksCli: cli, interactive: false });

    await expect(
      runInit(
        {
          cwd: testEnv.cwd,
          project: "projects/foo",
          from: "introspect",
          yes: true,
        },
        deps,
      ),
    ).rejects.toThrow(/specify --profile/);
  });

  test("errors when --project is absent and multiple projects exist", async () => {
    testEnv = mkTempProject({ schema: true });
    const cli = fakeCli({
      projects: [
        { name: "projects/foo", status: { display_name: "Foo" } },
        { name: "projects/bar", status: { display_name: "Bar" } },
      ],
    });
    const deps = makeDeps({ databricksCli: cli, interactive: false });

    await expect(
      runInit(
        {
          cwd: testEnv.cwd,
          profile: "DEFAULT",
          from: "introspect",
          yes: true,
        },
        deps,
      ),
    ).rejects.toThrow(/specify --project/);
  });

  test("rejects --profile that doesn't exist", async () => {
    testEnv = mkTempProject({ schema: true });
    const deps = makeDeps({ interactive: false });

    await expect(
      runInit(
        {
          cwd: testEnv.cwd,
          profile: "NOT_A_REAL_PROFILE",
          project: "projects/foo",
          from: "introspect",
          yes: true,
        },
        deps,
      ),
    ).rejects.toThrow(/Profile "NOT_A_REAL_PROFILE" not found/);
  });
});
