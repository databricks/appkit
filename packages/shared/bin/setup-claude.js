#!/usr/bin/env node

/**
 * CLI tool to setup CLAUDE.md for Databricks AppKit packages.
 *
 * This bin is included in both @databricks/appkit and @databricks/appkit-ui
 * so it's available regardless of which package the user installs.
 *
 * Usage:
 *   npx appkit-setup          # Show detected packages and content
 *   npx appkit-setup --write  # Create or update CLAUDE.md file
 */

import fs from "node:fs";
import path from "node:path";

const PACKAGES = [
  { name: "@databricks/appkit", description: "Backend SDK" },
  {
    name: "@databricks/appkit-ui",
    description: "UI Integration, Charts, Tables, SSE, and more.",
  },
];

const SECTION_START = "<!-- appkit-instructions-start -->";
const SECTION_END = "<!-- appkit-instructions-end -->";

/**
 * Find which AppKit packages are installed by checking for CLAUDE.md
 */
function findInstalledPackages() {
  const cwd = process.cwd();
  const installed = [];

  for (const pkg of PACKAGES) {
    const claudePath = path.join(cwd, "node_modules", pkg.name, "CLAUDE.md");
    if (fs.existsSync(claudePath)) {
      installed.push(pkg);
    }
  }

  return installed;
}

/**
 * Generate the AppKit section content
 */
function generateSection(packages) {
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
${SECTION_END}`;
}

/**
 * Generate standalone CLAUDE.md content (when no existing file)
 */
function generateStandalone(packages) {
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
${SECTION_END}
`;
}

/**
 * Update existing content with AppKit section
 */
function updateContent(existingContent, packages) {
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

/**
 * Main CLI logic
 */
function main() {
  const args = process.argv.slice(2);
  const shouldWrite = args.includes("--write") || args.includes("-w");
  const help = args.includes("--help") || args.includes("-h");

  if (help) {
    console.log(`
Usage: npx appkit-setup [options]

Options:
  --write, -w   Create or update CLAUDE.md file in current directory
  --help, -h    Show this help message

Examples:
  npx appkit-setup              # Show detected packages and preview content
  npx appkit-setup --write      # Create or update CLAUDE.md
`);
    return;
  }

  // Find installed packages
  const installed = findInstalledPackages();

  if (installed.length === 0) {
    console.log("No @databricks/appkit packages found in node_modules.");
    console.log("\nMake sure you've installed at least one of:");
    PACKAGES.forEach((pkg) => {
      console.log(`  - ${pkg.name}`);
    });
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

  let finalContent;
  let action;

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
    console.log("  npx appkit-setup --write\n");

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
}

main();
