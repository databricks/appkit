import { Command } from "commander";
import { type InstalledSkill, installSkills } from "./install-skills";

function describe(skill: InstalledSkill): string {
  switch (skill.action) {
    case "linked":
      return `  ✓ /${skill.name} → linked`;
    case "copied":
      return `  ✓ /${skill.name} → copied`;
    case "replaced":
      return `  ✓ /${skill.name} → updated`;
    case "skipped":
      return `  – /${skill.name} → skipped (${skill.reason})`;
  }
}

function runInstall(options: {
  dir?: string;
  copy?: boolean;
  force?: boolean;
}) {
  let result: ReturnType<typeof installSkills>;
  try {
    result = installSkills(options);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  if (result.installed.length === 0) {
    console.log("No skills found to install.");
    return;
  }

  console.log(`Installing AppKit skills into ${result.commandsDir}:`);
  for (const skill of result.installed) {
    console.log(describe(skill));
  }

  const count = result.installed.filter((s) => s.action !== "skipped").length;
  if (count > 0) {
    console.log(
      `\n✓ ${count} skill${count === 1 ? "" : "s"} available as slash commands.`,
    );
  }
}

const installSkillsCommand = new Command("install")
  .description("Install AppKit skills as slash commands in .claude/commands/")
  .option("--dir <path>", "Target project directory (default: cwd)")
  .option(
    "--copy",
    "Copy files instead of symlinking (portable for git/deploy)",
  )
  .option("--force", "Overwrite existing files that aren't AppKit-managed")
  .addHelpText(
    "after",
    `
Examples:
  $ appkit skills install
  $ appkit skills install --copy
  $ appkit skills install --dir ./my-app`,
  )
  .action(runInstall);

export const skillsCommand = new Command("skills")
  .description("Manage AppKit skills (slash commands for AI assistants)")
  .addCommand(installSkillsCommand)
  .addHelpText(
    "after",
    `
Examples:
  $ appkit skills install
  $ appkit skills install --copy`,
  );
