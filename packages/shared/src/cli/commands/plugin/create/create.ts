import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  cancel,
  confirm,
  intro,
  isCancel,
  multiselect,
  outro,
  select,
  spinner,
  text,
} from "@clack/prompts";
import { Command, Option } from "commander";
import { promptOneResource } from "./prompt-resource";
import {
  DEFAULT_PERMISSION_BY_TYPE,
  getDefaultFieldsForType,
  getValidResourceTypes,
  humanizeResourceType,
  RESOURCE_TYPE_OPTIONS,
  resourceKeyFromType,
} from "./resource-defaults";
import { resolveTargetDir, scaffoldPlugin } from "./scaffold";
import type { CreateAnswers, Placement, SelectedResource } from "./types";

const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const DEFAULT_VERSION = "0.1.0";
const VALID_PLACEMENTS: Placement[] = ["in-repo", "isolated"];
const REQUIRED_FLAGS = ["placement", "path", "name", "description"] as const;

interface CreateOptions {
  placement?: string;
  path?: string;
  name?: string;
  displayName?: string;
  description?: string;
  resources?: string;
  resourcesJson?: string;
  force?: boolean;
}

function deriveDisplayName(name: string): string {
  return name
    .split("-")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
}

function deriveExportName(name: string): string {
  return name
    .split("-")
    .map((s, i) => (i === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1)))
    .join("");
}

function buildResourceFromType(type: string): SelectedResource {
  return {
    type,
    required: true,
    description: `Required for ${humanizeResourceType(type)} functionality.`,
    resourceKey: resourceKeyFromType(type),
    permission: DEFAULT_PERMISSION_BY_TYPE[type] ?? "CAN_VIEW",
    fields: getDefaultFieldsForType(type),
  };
}

interface JsonResourceEntry {
  type: string;
  required?: boolean;
  description?: string;
  resourceKey?: string;
  permission?: string;
  fields?: Record<string, { env: string; description?: string }>;
}

function parseResourcesJson(json: string): SelectedResource[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    console.error("Error: --resources-json must be valid JSON.");
    console.error('  Example: --resources-json \'[{"type":"sql_warehouse"}]\'');
    process.exit(1);
  }

  if (!Array.isArray(parsed)) {
    console.error("Error: --resources-json must be a JSON array.");
    console.error('  Example: --resources-json \'[{"type":"sql_warehouse"}]\'');
    process.exit(1);
  }

  return (parsed as JsonResourceEntry[]).map((entry, i) => {
    if (entry == null || typeof entry !== "object") {
      console.error(`Error: --resources-json entry ${i} is not an object.`);
      process.exit(1);
    }
    if (!entry.type || typeof entry.type !== "string") {
      console.error(
        `Error: --resources-json entry ${i} missing required "type" field.`,
      );
      process.exit(1);
    }
    validateResourceType(entry.type);
    const defaults = buildResourceFromType(entry.type);
    return {
      type: entry.type,
      required: entry.required ?? defaults.required,
      description: entry.description ?? defaults.description,
      resourceKey: entry.resourceKey ?? defaults.resourceKey,
      permission: entry.permission ?? defaults.permission,
      fields: entry.fields ?? defaults.fields,
    };
  });
}

function validateResourceType(type: string): void {
  const validTypes = getValidResourceTypes();
  if (!validTypes.includes(type)) {
    console.error(`Error: Unknown resource type "${type}".`);
    console.error(`  Valid types: ${validTypes.join(", ")}`);
    process.exit(1);
  }
}

function parseResourcesShorthand(csv: string): SelectedResource[] {
  const types = csv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const t of types) validateResourceType(t);
  return types.map(buildResourceFromType);
}

function printNextSteps(answers: CreateAnswers, targetDir: string): void {
  const relativePath = path.relative(process.cwd(), targetDir);
  const importPath = relativePath.startsWith(".")
    ? relativePath
    : `./${relativePath}`;
  const exportName = deriveExportName(answers.name);

  console.log("\nNext steps:\n");
  if (answers.placement === "in-repo") {
    console.log(`  1. Import and register in your server:`);
    console.log(`     import { ${exportName} } from "${importPath}";`);
    console.log(`     createApp({ plugins: [ ..., ${exportName}() ] });`);
    console.log(
      `  2. Run \`npx appkit plugin sync --write\` to update appkit.plugins.json.\n`,
    );
  } else {
    console.log(`  1. cd into the new package and install dependencies:`);
    console.log(`     cd ${answers.targetPath} && pnpm install`);
    console.log(`  2. Build: pnpm build`);
    console.log(
      `  3. In your app: pnpm add ./${answers.targetPath} @databricks/appkit`,
    );
    console.log(
      `  4. Import and register: import { ${exportName} } from "<package-name>";\n`,
    );
  }
}

function runNonInteractive(opts: CreateOptions): void {
  const missing = REQUIRED_FLAGS.filter((f) => !opts[f]);
  if (missing.length > 0) {
    console.error(
      `Error: Non-interactive mode requires: ${REQUIRED_FLAGS.map((f) => `--${f}`).join(", ")}`,
    );
    console.error(`Missing: ${missing.map((f) => `--${f}`).join(", ")}`);
    console.error(
      '  appkit plugin create --placement in-repo --path plugins/my-plugin --name my-plugin --description "Does X"',
    );
    process.exit(1);
  }

  const placement = opts.placement as Placement;
  if (!VALID_PLACEMENTS.includes(placement)) {
    console.error(
      `Error: --placement must be one of: ${VALID_PLACEMENTS.join(", ")}`,
    );
    process.exit(1);
  }

  const targetPath = (opts.path as string).trim();
  if (
    placement === "in-repo" &&
    (path.isAbsolute(targetPath) || targetPath.startsWith(".."))
  ) {
    console.error(
      "Error: --path must be a relative path under the current directory for in-repo plugins.",
    );
    process.exit(1);
  }

  const name = opts.name as string;
  if (!NAME_PATTERN.test(name)) {
    console.error(
      "Error: --name must be lowercase, start with a letter, and use only letters, numbers, and hyphens.",
    );
    process.exit(1);
  }

  let resources: SelectedResource[] = [];
  if (opts.resourcesJson) {
    resources = parseResourcesJson(opts.resourcesJson);
  } else if (opts.resources) {
    resources = parseResourcesShorthand(opts.resources);
  }

  const answers: CreateAnswers = {
    placement,
    targetPath,
    name: name.trim(),
    displayName: opts.displayName?.trim() || deriveDisplayName(name),
    description: (opts.description as string).trim(),
    resources,
    version: DEFAULT_VERSION,
  };

  const targetDir = resolveTargetDir(process.cwd(), answers);
  const dirExists = fs.existsSync(targetDir);
  const hasContent = dirExists && fs.readdirSync(targetDir).length > 0;
  if (hasContent && !opts.force) {
    console.error(
      `Error: Directory ${answers.targetPath} already exists and is not empty.`,
    );
    console.error("  Use --force to overwrite.");
    process.exit(1);
  }

  scaffoldPlugin(targetDir, answers, { isolated: placement === "isolated" });

  console.log(
    `Plugin "${answers.name}" created at ${path.relative(process.cwd(), targetDir)}`,
  );
  printNextSteps(answers, targetDir);
}

async function runInteractive(): Promise<void> {
  intro("Create a new AppKit plugin");

  try {
    const placement = await select<Placement>({
      message: "Where should the plugin live?",
      options: [
        {
          value: "in-repo",
          label: "In this repository (e.g. plugins/my-plugin)",
          hint: "folder path",
        },
        {
          value: "isolated",
          label: "New isolated package",
          hint: "full package with package.json",
        },
      ],
    });
    if (isCancel(placement)) {
      cancel("Cancelled.");
      process.exit(0);
    }

    const placementPrompt =
      placement === "in-repo"
        ? "Folder path for the plugin (e.g. plugins/my-feature)"
        : "Directory name for the new package (e.g. appkit-plugin-my-feature)";
    const targetPath = await text({
      message: placementPrompt,
      placeholder:
        placement === "in-repo"
          ? "plugins/my-plugin"
          : "appkit-plugin-my-feature",
      validate(value) {
        if (!value?.trim()) return "Path is required.";
        if (
          placement === "in-repo" &&
          (path.isAbsolute(value) || value.trim().startsWith(".."))
        ) {
          return "Use a relative path under the current directory (e.g. plugins/my-plugin).";
        }
        return undefined;
      },
    });
    if (isCancel(targetPath)) {
      cancel("Cancelled.");
      process.exit(0);
    }

    const name = await text({
      message: "Plugin name (id)",
      placeholder: "my-plugin",
      validate(value) {
        if (!value?.trim()) return "Name is required.";
        if (!NAME_PATTERN.test(value as string)) {
          return "Must be lowercase, start with a letter, and use only letters, numbers, and hyphens.";
        }
        return undefined;
      },
    });
    if (isCancel(name)) {
      cancel("Cancelled.");
      process.exit(0);
    }

    const displayName = await text({
      message: "Display name",
      placeholder: "My Plugin",
      initialValue: name
        .split("-")
        .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
        .join(" "),
      validate(value) {
        if (!value?.trim()) return "Display name is required.";
        return undefined;
      },
    });
    if (isCancel(displayName)) {
      cancel("Cancelled.");
      process.exit(0);
    }

    const description = await text({
      message: "Short description",
      placeholder: "What does this plugin do?",
      validate(value) {
        if (!value?.trim()) return "Description is required.";
        return undefined;
      },
    });
    if (isCancel(description)) {
      cancel("Cancelled.");
      process.exit(0);
    }

    const resourceTypes = await multiselect({
      message: "Which Databricks resources does this plugin need?",
      options: RESOURCE_TYPE_OPTIONS.map((o) => ({
        value: o.value,
        label: o.label,
      })),
      required: false,
    });
    if (isCancel(resourceTypes)) {
      cancel("Cancelled.");
      process.exit(0);
    }

    const resources: CreateAnswers["resources"] = [];
    for (const type of resourceTypes as string[]) {
      const spec = await promptOneResource({ type });
      if (!spec) {
        cancel("Cancelled.");
        process.exit(0);
      }
      resources.push({
        type: spec.type,
        required: spec.required,
        description: spec.description,
        resourceKey: spec.resourceKey,
        permission: spec.permission,
        fields: spec.fields,
      });
    }

    const answers: CreateAnswers = {
      placement,
      targetPath: (targetPath as string).trim(),
      name: (name as string).trim(),
      displayName: (displayName as string).trim(),
      description: (description as string).trim(),
      resources,
      version: DEFAULT_VERSION,
    };

    const targetDir = resolveTargetDir(process.cwd(), answers);
    const dirExists = fs.existsSync(targetDir);
    const hasContent = dirExists && fs.readdirSync(targetDir).length > 0;
    if (hasContent) {
      const overwrite = await confirm({
        message: `Directory ${answers.targetPath} already exists and is not empty. Overwrite?`,
        initialValue: false,
      });
      if (isCancel(overwrite) || !overwrite) {
        cancel("Cancelled.");
        process.exit(0);
      }
    }

    const s = spinner();
    s.start("Writing files…");
    try {
      scaffoldPlugin(targetDir, answers, {
        isolated: placement === "isolated",
      });
      s.stop("Files written.");
    } catch (err) {
      s.stop("Failed.");
      throw err;
    }

    outro("Plugin created successfully.");
    printNextSteps(answers, targetDir);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

const OPTIONAL_FLAGS = [
  "displayName",
  "resources",
  "resourcesJson",
  "force",
] as const;

async function runPluginCreate(opts: CreateOptions): Promise<void> {
  const hasRequiredFlag = REQUIRED_FLAGS.some((f) => opts[f] !== undefined);
  if (hasRequiredFlag) {
    runNonInteractive(opts);
  } else {
    const hasOptionalOnly = OPTIONAL_FLAGS.some(
      (f) => opts[f] !== undefined && opts[f] !== false,
    );
    if (hasOptionalOnly) {
      console.error(
        `Error: Non-interactive mode requires: ${REQUIRED_FLAGS.map((f) => `--${f}`).join(", ")}`,
      );
      console.error(
        '  appkit plugin create --placement in-repo --path plugins/my-plugin --name my-plugin --description "Does X"',
      );
      process.exit(1);
    }
    await runInteractive();
  }
}

export const pluginCreateCommand = new Command("create")
  .description("Scaffold a new AppKit plugin")
  .option("--placement <type>", "Where the plugin lives (in-repo, isolated)")
  .option("--path <dir>", "Target directory for the plugin")
  .option("--name <id>", "Plugin name (lowercase, hyphens allowed)")
  .option("--display-name <name>", "Human-readable display name")
  .option("--description <text>", "Short description of the plugin")
  .addOption(
    new Option(
      "--resources <types>",
      "Comma-separated resource types (e.g. sql_warehouse,volume)",
    ).conflicts("resourcesJson"),
  )
  .addOption(
    new Option(
      "--resources-json <json>",
      'JSON array of resource specs (e.g. \'[{"type":"sql_warehouse"}]\')',
    ).conflicts("resources"),
  )
  .option("-f, --force", "Overwrite existing directory without confirmation")
  .addHelpText(
    "after",
    `
Examples:
  $ appkit plugin create
  $ appkit plugin create --placement in-repo --path plugins/my-plugin --name my-plugin --description "Does X"
  $ appkit plugin create --placement in-repo --path plugins/my-plugin --name my-plugin --description "Does X" --resources sql_warehouse,volume --force
  $ appkit plugin create --placement isolated --path appkit-plugin-ml --name ml --description "ML" --resources-json '[{"type":"serving_endpoint"}]'`,
  )
  .action((opts) =>
    runPluginCreate(opts).catch((err) => {
      console.error(err);
      process.exit(1);
    }),
  );

/** Exported for testing. */
export { buildResourceFromType, parseResourcesJson, parseResourcesShorthand };
