#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { setupCommand } from "./commands/setup.js";
import { generateTypesCommand } from "./commands/generate-types.js";
import { lintCommand } from "./commands/lint.js";
import { docsCommand } from "./commands/docs.js";

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

cmd.parse();
