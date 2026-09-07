#!/usr/bin/env node
import "dotenv/config";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Command } from "commander";

import { agentCommand } from "./commands/agent/index.js";
import { codemodCommand } from "./commands/codemod/index.js";
import { docsCommand } from "./commands/docs.js";
import { doctorCommand } from "./commands/doctor/index.js";
import { generateTypesCommand } from "./commands/generate-types.js";
import { lintCommand } from "./commands/lint.js";
import { pluginCommand } from "./commands/plugin/index.js";
import { addCommand } from "./commands/registry/add.js";
import { registryCommand } from "./commands/registry/index.js";
import { setupCommand } from "./commands/setup.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(__dirname, "../../package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

const cmd = new Command();

cmd
  .name("appkit")
  .description("CLI tools for Databricks AppKit")
  .version(pkg.version);

cmd.addCommand(setupCommand);
cmd.addCommand(generateTypesCommand);
cmd.addCommand(lintCommand);
cmd.addCommand(docsCommand);
cmd.addCommand(pluginCommand);
cmd.addCommand(codemodCommand);
cmd.addCommand(doctorCommand);
// Registry commands are executable but hidden from --help while the feature
// is still in development (registry + add work end-to-end but aren't announced).
cmd.addCommand(registryCommand, { hidden: true });
cmd.addCommand(addCommand, { hidden: true });
cmd.addCommand(agentCommand);

await cmd.parseAsync();
