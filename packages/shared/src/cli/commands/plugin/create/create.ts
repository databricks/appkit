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
import { Command } from "commander";
import { promptOneResource } from "./prompt-resource";
import { RESOURCE_TYPE_OPTIONS } from "./resource-defaults";
import { resolveTargetDir, scaffoldPlugin } from "./scaffold";
import type { CreateAnswers, Placement } from "./types";

const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const DEFAULT_VERSION = "0.1.0";

async function runPluginCreate(): Promise<void> {
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

    const relativePath = path.relative(process.cwd(), targetDir);
    const importPath = relativePath.startsWith(".")
      ? relativePath
      : `./${relativePath}`;
    const exportName = answers.name
      .split("-")
      .map((s, i) => (i === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1)))
      .join("");

    outro("Plugin created successfully.");

    console.log("\nNext steps:\n");
    if (placement === "in-repo") {
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
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

export const pluginCreateCommand = new Command("create")
  .description("Scaffold a new AppKit plugin (interactive)")
  .action(runPluginCreate);
