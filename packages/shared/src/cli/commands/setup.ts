import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import yaml from "js-yaml";

const PACKAGES = [
  { name: "@databricks/appkit", description: "Backend SDK" },
  {
    name: "@databricks/appkit-ui",
    description: "UI Integration, Charts, Tables, SSE, and more.",
  },
];

const SECTION_START = "<!-- appkit-instructions-start -->";
const SECTION_END = "<!-- appkit-instructions-end -->";

const MLFLOW_UC_ENV_NAMES = [
  "MLFLOW_EXPERIMENT_ID",
  "MLFLOW_TRACING_SQL_WAREHOUSE_ID",
  "MLFLOW_UC_CATALOG",
  "MLFLOW_UC_SCHEMA",
  "MLFLOW_UC_TABLE_PREFIX",
  "MLFLOW_OTEL_SPANS_TABLE",
] as const;

const MLFLOW_BUNDLE_VARIABLE_NAMES: Record<
  (typeof MLFLOW_UC_ENV_NAMES)[number],
  string
> = {
  MLFLOW_EXPERIMENT_ID: "mlflow_experiment_id",
  MLFLOW_TRACING_SQL_WAREHOUSE_ID: "mlflow_tracing_warehouse_id",
  MLFLOW_UC_CATALOG: "MLFLOW_UC_CATALOG",
  MLFLOW_UC_SCHEMA: "MLFLOW_UC_SCHEMA",
  MLFLOW_UC_TABLE_PREFIX: "MLFLOW_UC_TABLE_PREFIX",
  MLFLOW_OTEL_SPANS_TABLE: "MLFLOW_OTEL_SPANS_TABLE",
};

const MLFLOW_RESOURCE_BINDING_ENV_NAMES = new Set([
  "MLFLOW_EXPERIMENT_ID",
  "MLFLOW_TRACING_SQL_WAREHOUSE_ID",
]);

export type MlflowUcValues = Record<
  (typeof MLFLOW_UC_ENV_NAMES)[number],
  string
>;

export interface MlflowUcSetupOptions {
  cwd: string;
  profile: string;
  experimentName: string;
  catalog: string;
  schema: string;
  tablePrefix: string;
  warehouseId: string;
  runtimePrincipal: string;
}

interface MlflowUcSetupDependencies {
  scriptPath?: string;
  run?: (command: string[]) => number;
  log?: (message: string) => void;
  workspaceHost?: string;
}

function readEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  return Object.fromEntries(
    fs
      .readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .flatMap((line) => {
        const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
        return match ? [[match[1], match[2]]] : [];
      }),
  );
}

export function projectRequiresMlflowUc(
  cwd: string,
  explicitlySelected: boolean,
): boolean {
  if (explicitlySelected) return true;
  const manifestPath = path.join(cwd, "appkit.plugins.json");
  if (!fs.existsSync(manifestPath)) return false;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      plugins?: { agents?: { requiredByTemplate?: boolean } };
    };
    return manifest.plugins?.agents?.requiredByTemplate === true;
  } catch (error) {
    throw new Error(`Could not read ${manifestPath}: ${String(error)}`);
  }
}

export function buildMlflowProvisionCommand(
  options: MlflowUcSetupOptions & { scriptPath: string },
): string[] {
  return [
    "uv",
    "run",
    "--no-project",
    "--with",
    "mlflow[databricks]>=3.14.0,<4",
    "python",
    options.scriptPath,
    "--profile",
    options.profile,
    "--experiment-name",
    options.experimentName,
    "--catalog",
    options.catalog,
    "--schema",
    options.schema,
    "--table-prefix",
    options.tablePrefix,
    "--warehouse-id",
    options.warehouseId,
    "--runtime-principal",
    options.runtimePrincipal,
    "--output-json",
    path.join(options.cwd, ".databricks", "mlflow-uc.json"),
  ];
}

function validateMlflowUcValues(value: unknown): MlflowUcValues {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("MLflow UC provisioner returned invalid JSON");
  }
  const record = value as Record<string, unknown>;
  const missing = MLFLOW_UC_ENV_NAMES.filter(
    (name) => typeof record[name] !== "string" || !record[name],
  );
  if (missing.length > 0) {
    throw new Error(
      `MLflow UC provisioner output missing: ${missing.join(", ")}`,
    );
  }
  return Object.fromEntries(
    MLFLOW_UC_ENV_NAMES.map((name) => [name, record[name] as string]),
  ) as MlflowUcValues;
}

function persistDotEnv(
  filePath: string,
  values: MlflowUcValues,
  workspaceHost?: string,
): void {
  const existing = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, "utf8").split(/\r?\n/)
    : [];
  const remaining = existing.filter(
    (line) =>
      !MLFLOW_UC_ENV_NAMES.some((name) => line.startsWith(`${name}=`)) &&
      (!workspaceHost || !line.startsWith("DATABRICKS_HOST=")),
  );
  const lines = [
    ...remaining.filter((line, index) => line || index < remaining.length - 1),
    ...(workspaceHost ? [`DATABRICKS_HOST=${workspaceHost}`] : []),
    ...MLFLOW_UC_ENV_NAMES.map((name) => `${name}=${values[name]}`),
  ];
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`);
}

function loadYamlObject(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  const parsed = yaml.load(fs.readFileSync(filePath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${filePath} must contain a YAML object`);
  }
  return parsed as Record<string, unknown>;
}

function writeYamlObject(
  filePath: string,
  document: Record<string, unknown>,
): void {
  fs.writeFileSync(
    filePath,
    yaml.dump(document, { lineWidth: 100, noRefs: true, quotingType: '"' }),
  );
}

function persistAppYaml(filePath: string, values: MlflowUcValues): void {
  const document = loadYamlObject(filePath) as {
    env?: Array<{ name?: string; value?: string; valueFrom?: string }>;
  };
  const existing = Array.isArray(document.env) ? document.env : [];
  const existingByName = new Map(existing.map((entry) => [entry.name, entry]));
  document.env = [
    ...existing.filter(
      (entry) =>
        !MLFLOW_UC_ENV_NAMES.includes(
          entry.name as (typeof MLFLOW_UC_ENV_NAMES)[number],
        ),
    ),
    ...MLFLOW_UC_ENV_NAMES.map((name) => {
      const entry = existingByName.get(name);
      if (
        MLFLOW_RESOURCE_BINDING_ENV_NAMES.has(name) &&
        typeof entry?.valueFrom === "string" &&
        entry.valueFrom
      ) {
        return { name, valueFrom: entry.valueFrom };
      }
      return { name, value: values[name] };
    }),
  ];
  writeYamlObject(filePath, document as Record<string, unknown>);
}

function persistBundleYaml(filePath: string, values: MlflowUcValues): void {
  const document = loadYamlObject(filePath) as {
    variables?: Record<string, unknown>;
    targets?: Record<string, { variables?: Record<string, string> }>;
  };
  document.variables ??= {};
  for (const name of MLFLOW_UC_ENV_NAMES) {
    const variableName = MLFLOW_BUNDLE_VARIABLE_NAMES[name];
    const existing = document.variables[variableName];
    document.variables[variableName] = {
      ...(existing && typeof existing === "object" ? existing : {}),
      description: `AppKit MLflow UC tracing: ${name}`,
      default: values[name],
    };
  }
  document.targets ??= {};
  document.targets.default ??= {};
  document.targets.default.variables ??= {};
  for (const name of MLFLOW_UC_ENV_NAMES) {
    document.targets.default.variables[MLFLOW_BUNDLE_VARIABLE_NAMES[name]] =
      values[name];
  }
  writeYamlObject(filePath, document as Record<string, unknown>);
}

export async function provisionAndPersistMlflowUc(
  options: MlflowUcSetupOptions,
  dependencies: MlflowUcSetupDependencies = {},
): Promise<MlflowUcValues> {
  const outputPath = path.join(options.cwd, ".databricks", "mlflow-uc.json");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const scriptPath =
    dependencies.scriptPath ??
    path.join(
      options.cwd,
      "node_modules",
      "@databricks",
      "appkit",
      "scripts",
      "provision-mlflow-uc.py",
    );
  if (!fs.existsSync(scriptPath) && !dependencies.run) {
    throw new Error(`MLflow UC provisioner not found: ${scriptPath}`);
  }
  const command = buildMlflowProvisionCommand({ ...options, scriptPath });
  const run =
    dependencies.run ??
    ((argv: string[]) =>
      spawnSync(argv[0], argv.slice(1), {
        cwd: options.cwd,
        stdio: "inherit",
      }).status ?? 1);
  const status = run(command);
  if (status !== 0) {
    throw new Error(`MLflow UC provisioning failed with exit code ${status}`);
  }

  const values = validateMlflowUcValues(
    JSON.parse(fs.readFileSync(outputPath, "utf8")),
  );
  const host = dependencies.workspaceHost?.replace(/\/+$/, "");
  persistDotEnv(path.join(options.cwd, ".env"), values, host);
  persistAppYaml(path.join(options.cwd, "app.yaml"), values);
  persistBundleYaml(path.join(options.cwd, "databricks.yml"), values);

  const log = dependencies.log ?? console.log;
  if (host) {
    log(
      `MLflow experiment: ${host}/ml/experiments/${encodeURIComponent(values.MLFLOW_EXPERIMENT_ID)}/traces`,
    );
  }
  return values;
}

/**
 * Find which AppKit packages are installed by checking for package.json
 */
function findInstalledPackages() {
  const cwd = process.cwd();
  const installed = [];

  for (const pkg of PACKAGES) {
    const packagePath = path.join(
      cwd,
      "node_modules",
      pkg.name,
      "package.json",
    );
    if (fs.existsSync(packagePath)) {
      installed.push(pkg);
    }
  }

  return installed;
}

/**
 * Generate the AppKit section content
 */
function generateSection(packages: typeof PACKAGES) {
  const links = packages
    .map((pkg) => {
      const docPath = `./node_modules/${pkg.name}/CLAUDE.md`;
      return `- **${pkg.name}** (${pkg.description}): [${docPath}](${docPath})`;
    })
    .join("\n");

  return `${SECTION_START}
## Databricks AppKit

This project uses Databricks AppKit packages. For AI assistant guidance on using these packages, refer to:

${links}

### Databricks Skills

For enhanced AI assistance with Databricks CLI operations, authentication, data exploration, and app development, install the Databricks skills:

\`\`\`bash
databricks aitools install
\`\`\`
${SECTION_END}`;
}

/**
 * Generate standalone CLAUDE.md content (when no existing file)
 */
function generateStandalone(packages: typeof PACKAGES) {
  const links = packages
    .map((pkg) => {
      const docPath = `./node_modules/${pkg.name}/CLAUDE.md`;
      return `- **${pkg.name}** (${pkg.description}): [${docPath}](${docPath})`;
    })
    .join("\n");

  return `# AI Assistant Instructions

${SECTION_START}
## Databricks AppKit

This project uses Databricks AppKit packages. For AI assistant guidance on using these packages, refer to:

${links}

### Databricks Skills

For enhanced AI assistance with Databricks CLI operations, authentication, data exploration, and app development, install the Databricks skills:

\`\`\`bash
databricks aitools install
\`\`\`
${SECTION_END}
`;
}

/**
 * Update existing content with AppKit section
 */
function updateContent(existingContent: string, packages: typeof PACKAGES) {
  const newSection = generateSection(packages);

  // Check if AppKit section already exists
  const startIndex = existingContent.indexOf(SECTION_START);
  const endIndex = existingContent.indexOf(SECTION_END);

  if (startIndex !== -1 && endIndex !== -1) {
    // Replace existing section
    const before = existingContent.substring(0, startIndex);
    const after = existingContent.substring(endIndex + SECTION_END.length);
    return before + newSection + after;
  }

  // Append section to end
  return `${existingContent.trimEnd()}\n\n${newSection}\n`;
}

interface SetupCliOptions {
  write?: boolean;
  mlflowUc?: boolean;
  mlflowCatalog: string;
  mlflowSchema: string;
  mlflowTablePrefix: string;
  mlflowWarehouseId?: string;
  mlflowRuntimePrincipal?: string;
}

function databricksJson(args: string[]): unknown {
  const result = spawnSync("databricks", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() ||
        `databricks ${args.join(" ")} failed with exit code ${result.status}`,
    );
  }
  return JSON.parse(result.stdout);
}

function resolveDatabricksUser(profile: string): string {
  const user = databricksJson([
    "current-user",
    "me",
    "--profile",
    profile,
    "--output",
    "json",
  ]) as { userName?: unknown; user_name?: unknown };
  const value = user.userName ?? user.user_name;
  if (typeof value !== "string" || !value) {
    throw new Error(
      "Databricks current user response did not include userName",
    );
  }
  return value;
}

function resolveWorkspaceHost(
  profile: string,
  env: Record<string, string>,
): string {
  const configured = process.env.DATABRICKS_HOST ?? env.DATABRICKS_HOST;
  if (configured) return configured;
  const response = databricksJson(["auth", "profiles", "--output", "json"]);
  const profiles = Array.isArray(response)
    ? response
    : (response as { profiles?: unknown }).profiles;
  const selected = Array.isArray(profiles)
    ? profiles.find(
        (candidate) =>
          candidate &&
          typeof candidate === "object" &&
          (candidate as { name?: unknown }).name === profile,
      )
    : undefined;
  const host = (selected as { host?: unknown } | undefined)?.host;
  if (typeof host !== "string" || !host) {
    throw new Error(`Could not resolve workspace host for profile ${profile}`);
  }
  return host;
}

/**
 * Setup command implementation
 */
async function runSetup(options: SetupCliOptions) {
  const shouldWrite = options.write;

  // Find installed packages
  const installed = findInstalledPackages();

  if (installed.length === 0) {
    console.log("No @databricks/appkit packages found in node_modules.");
    console.log("\nInstall at least one of:");
    for (const pkg of PACKAGES) {
      console.log(`  npm install ${pkg.name}`);
    }
    process.exit(1);
  }

  console.log("Detected packages:");
  installed.forEach((pkg) => {
    console.log(`  ✓ ${pkg.name}`);
  });

  const claudePath = path.join(process.cwd(), "CLAUDE.md");
  const existingContent = fs.existsSync(claudePath)
    ? fs.readFileSync(claudePath, "utf-8")
    : null;

  let finalContent: string;
  let action: string;

  if (existingContent) {
    finalContent = updateContent(existingContent, installed);
    action = existingContent.includes(SECTION_START) ? "Updated" : "Added to";
  } else {
    finalContent = generateStandalone(installed);
    action = "Created";
  }

  if (shouldWrite) {
    fs.writeFileSync(claudePath, finalContent);
    console.log(`\n✓ ${action} CLAUDE.md`);
    console.log(`  Path: ${claudePath}`);
  } else {
    console.log("\nTo create/update CLAUDE.md, run:");
    console.log("  npx appkit setup --write\n");

    if (existingContent) {
      console.log(
        `This will ${
          existingContent.includes(SECTION_START)
            ? "update the existing"
            : "add a new"
        } AppKit section.\n`,
      );
    }

    console.log("Preview of AppKit section:\n");
    console.log("─".repeat(50));
    console.log(generateSection(installed));
    console.log("─".repeat(50));
  }

  const cwd = process.cwd();
  if (projectRequiresMlflowUc(cwd, options.mlflowUc === true)) {
    const env = readEnvFile(path.join(cwd, ".env"));
    const profile =
      process.env.DATABRICKS_CONFIG_PROFILE ??
      env.DATABRICKS_CONFIG_PROFILE ??
      "DEFAULT";
    const warehouseId =
      options.mlflowWarehouseId ??
      process.env.MLFLOW_TRACING_SQL_WAREHOUSE_ID ??
      env.MLFLOW_TRACING_SQL_WAREHOUSE_ID ??
      process.env.DATABRICKS_WAREHOUSE_ID ??
      env.DATABRICKS_WAREHOUSE_ID;
    if (!warehouseId || warehouseId === "placeholder") {
      throw new Error(
        "MLflow UC setup requires --mlflow-warehouse-id (or MLFLOW_TRACING_SQL_WAREHOUSE_ID)",
      );
    }
    const userName = resolveDatabricksUser(profile);
    const runtimePrincipal =
      options.mlflowRuntimePrincipal ??
      process.env.DATABRICKS_APP_SERVICE_PRINCIPAL ??
      env.DATABRICKS_APP_SERVICE_PRINCIPAL;
    if (!runtimePrincipal?.trim()) {
      throw new Error(
        "MLflow UC setup requires --mlflow-runtime-principal (the deployed app service principal application ID)",
      );
    }
    const workspaceHost = resolveWorkspaceHost(profile, env);
    await provisionAndPersistMlflowUc(
      {
        cwd,
        profile,
        experimentName: `/Users/${userName}/appkit-agent-traces`,
        catalog: options.mlflowCatalog,
        schema: options.mlflowSchema,
        tablePrefix: options.mlflowTablePrefix,
        warehouseId,
        runtimePrincipal: runtimePrincipal.trim(),
      },
      { workspaceHost },
    );
  }
}

export const setupCommand = new Command("setup")
  .description("Set up AppKit project guidance and optional MLflow UC tracing")
  .option("-w, --write", "Create or update CLAUDE.md file in current directory")
  .option(
    "--mlflow-uc",
    "Provision MLflow tracing in Unity Catalog (implied by agents)",
  )
  .option("--mlflow-catalog <catalog>", "Unity Catalog catalog", "main")
  .option("--mlflow-schema <schema>", "Unity Catalog schema", "agent_traces")
  .option("--mlflow-table-prefix <prefix>", "UC trace table prefix", "appkit")
  .option(
    "--mlflow-warehouse-id <id>",
    "SQL warehouse used to provision and query UC trace tables",
  )
  .option(
    "--mlflow-runtime-principal <application-id>",
    "Deployed app service principal receiving explicit UC trace grants",
  )
  .addHelpText(
    "after",
    `
Examples:
  $ appkit setup
  $ appkit setup --write
  $ appkit setup --write --mlflow-uc --mlflow-warehouse-id 0123456789abcdef`,
  )
  .action(runSetup);
