import process from "node:process";
import { Command } from "commander";
import pc from "picocolors";
import { fetchRegistryItem, isValidItemName, stripNamespace } from "./client";
import { resolveToken } from "./constants";
import { extractRequirements, renderRequirements } from "./requirements";

async function runInfo(ref: string, opts: { json?: boolean }): Promise<void> {
  const token = resolveToken();
  // Validate before fetching: the name is interpolated into the fetch path, so
  // reject non-slug refs (matches the `add` guard) rather than let `/` or `..`
  // redirect the request to another path in the repo.
  const name = stripNamespace(ref);
  if (!isValidItemName(name)) {
    console.error(`Invalid registry item name: ${JSON.stringify(ref)}`);
    process.exit(1);
  }
  const item = await fetchRegistryItem(name, token);
  const rows = extractRequirements(item);

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          name: item.name,
          type: item.type,
          dependencies: item.dependencies ?? [],
          registryDependencies: item.registryDependencies ?? [],
          resources: rows,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(pc.bold(item.name));
  const deps = item.dependencies ?? [];
  const registryDeps = item.registryDependencies ?? [];
  if (deps.length > 0) {
    console.log(pc.dim(`  npm dependencies: ${deps.join(", ")}`));
  }
  if (registryDeps.length > 0) {
    console.log(pc.dim(`  registry dependencies: ${registryDeps.join(", ")}`));
  }
  console.log(`\n${renderRequirements(item, rows)}`);
}

export const registryInfoCommand = new Command("info")
  .description("Show an item's resource requirements and dependencies")
  .argument("<item>", "Registry item name, e.g. analytics")
  .option("--json", "Output as JSON")
  .addHelpText(
    "after",
    `
Examples:
  $ appkit registry info analytics
  $ appkit registry info @databricks-appkit/analytics --json`,
  )
  .action((ref: string, opts: { json?: boolean }) =>
    runInfo(ref, opts).catch((err) => {
      console.error(err);
      process.exit(1);
    }),
  );
