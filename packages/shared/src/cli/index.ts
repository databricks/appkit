#!/usr/bin/env node

import { Command } from "commander";
import { setupCommand } from "./commands/setup.js";
import { generateTypesCommand } from "./commands/generate-types.js";
import { lintCommand } from "./commands/lint.js";
import { docsCommand } from "./commands/docs.js";

const cmd = new Command();

cmd.name("appkit").description("CLI tools for Databricks AppKit");

cmd.addCommand(setupCommand);
cmd.addCommand(generateTypesCommand);
cmd.addCommand(lintCommand);
cmd.addCommand(docsCommand);

cmd.parse();
