import process from "node:process";
import { Command } from "commander";
import {
  REGISTRY_INDEX_API_URL,
  REGISTRY_INDEX_URL,
  REGISTRY_REPO,
  resolveToken,
} from "./constants";

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
  const token = resolveToken();
  const url = token ? REGISTRY_INDEX_API_URL : REGISTRY_INDEX_URL;
  const headers: Record<string, string> = {};
  if (token) {
    headers.Authorization = `Bearer ${token.value}`;
    headers.Accept = "application/vnd.github.raw";
  }

  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetch(url, { headers });
  } catch (err) {
    console.error(`Failed to reach the registry at ${url}`);
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (res.status === 404 || res.status === 401 || res.status === 403) {
    console.error(
      `Could not read the registry index from ${REGISTRY_REPO} (HTTP ${res.status}).`,
    );
    if (!token) {
      console.error(
        "  If the repo is private, set APPKIT_REGISTRY_TOKEN (or GITHUB_TOKEN) to a token with read access.",
      );
    }
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`Registry returned HTTP ${res.status} for ${url}`);
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
