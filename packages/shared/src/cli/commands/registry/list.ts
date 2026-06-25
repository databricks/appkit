import process from "node:process";
import { Command } from "commander";
import { REGISTRY_INDEX_URL } from "./constants";

interface RegistryIndexItem {
  name: string;
  title?: string;
  description?: string;
}

function printTable(items: RegistryIndexItem[]): void {
  if (items.length === 0) {
    console.log("No components found in the registry.");
    return;
  }
  const maxName = Math.max(4, ...items.map((i) => i.name.length));
  const header = `${"NAME".padEnd(maxName)}  DESCRIPTION`;
  console.log(header);
  console.log("-".repeat(header.length));
  for (const item of items) {
    console.log(
      `${item.name.padEnd(maxName)}  ${item.description ?? item.title ?? ""}`,
    );
  }
}

async function runList(opts: { json?: boolean }): Promise<void> {
  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetch(REGISTRY_INDEX_URL);
  } catch (err) {
    console.error(`Failed to reach the registry at ${REGISTRY_INDEX_URL}`);
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (!res.ok) {
    console.error(
      `Registry returned HTTP ${res.status} for ${REGISTRY_INDEX_URL}`,
    );
    process.exit(1);
  }

  const data = (await res.json()) as { items?: RegistryIndexItem[] };
  const items = data.items ?? [];

  if (opts.json) {
    console.log(JSON.stringify(items, null, 2));
  } else {
    printTable(items);
  }
}

export const registryListCommand = new Command("list")
  .description("List components available in the AppKit registry")
  .option("--json", "Output as JSON")
  .action((opts: { json?: boolean }) =>
    runList(opts).catch((err) => {
      console.error(err);
      process.exit(1);
    }),
  );
