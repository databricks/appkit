import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { Command } from "commander";
import { REGISTRY_ITEM_URL_TEMPLATE, REGISTRY_NAMESPACE } from "./constants";

interface ComponentsJson {
  registries?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Ensures the consumer's components.json declares the `@appkit` namespace so the
 * shadcn CLI can resolve `@appkit/<name>` references. Writes it if missing.
 */
function ensureNamespace(cwd: string): void {
  const file = path.join(cwd, "components.json");
  if (!fs.existsSync(file)) {
    console.error(`No components.json found in ${cwd}.`);
    console.error(
      "  Run `npx shadcn@latest init` first, or run this from your app root.",
    );
    process.exit(1);
  }

  let json: ComponentsJson;
  try {
    json = JSON.parse(fs.readFileSync(file, "utf-8")) as ComponentsJson;
  } catch (err) {
    console.error(
      `components.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  json.registries ??= {};
  if (json.registries[REGISTRY_NAMESPACE] !== REGISTRY_ITEM_URL_TEMPLATE) {
    json.registries[REGISTRY_NAMESPACE] = REGISTRY_ITEM_URL_TEMPLATE;
    fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
    console.log(
      `Configured ${REGISTRY_NAMESPACE} registry in components.json.`,
    );
  }
}

function runAdd(components: string[], opts: { yes?: boolean }): void {
  const cwd = process.cwd();
  ensureNamespace(cwd);

  // Accept bare names (`metric-card`) or already-namespaced refs (`@appkit/x`).
  const refs = components.map((c) =>
    c.includes("/") ? c : `${REGISTRY_NAMESPACE}/${c}`,
  );

  const args = ["shadcn@latest", "add", ...refs];
  if (opts.yes) args.push("--yes");

  const result = spawnSync("npx", args, { stdio: "inherit", cwd });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  console.log(
    '\nReminder: import "@databricks/appkit-ui/styles.css" once at your app root so the component is themed.',
  );
}

export const addCommand = new Command("add")
  .description("Add an AppKit registry component to your project")
  .argument("<component...>", "Component name(s), e.g. metric-card")
  .option("-y, --yes", "Skip confirmation prompts")
  .addHelpText(
    "after",
    `
Examples:
  $ appkit add metric-card
  $ appkit add metric-card data-table
  $ appkit add @appkit/metric-card`,
  )
  .action((components: string[], opts: { yes?: boolean }) =>
    runAdd(components, opts),
  );
