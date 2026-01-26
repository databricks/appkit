#!/usr/bin/env node

import { Command } from "commander";
import { setupCommand } from "./commands/setup.js";
import { generateTypesCommand } from "./commands/generate-types.js";
import { lintCommand } from "./commands/lint.js";
import { docsCommand } from "./commands/docs.js";

const program = new Command();

program
  .name("appkit")
  .description("CLI tools for Databricks AppKit")
  .version("0.1.5");

// Add commands
program.addCommand(setupCommand);
program.addCommand(generateTypesCommand);
program.addCommand(lintCommand);
program.addCommand(docsCommand);

program.parse();
