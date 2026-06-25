import process from "node:process";
import { Command } from "commander";
import pc from "picocolors";
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
  meta?: { verified?: boolean };
}

function isVerified(item: RegistryIndexItem): boolean {
  return item.meta?.verified === true;
}

function printTable(items: RegistryIndexItem[]): void {
  if (items.length === 0) {
    console.log(pc.dim("No items found in the registry."));
    return;
  }
  const maxName = Math.max(4, ...items.map((i) => i.name.length));
  const verifiedCol = "VERIFIED";
  // Pad plain text before coloring so ANSI codes don't break alignment.
  const header = `${"NAME".padEnd(maxName)}  ${verifiedCol}  DESCRIPTION`;
  console.log(pc.bold(header));
  console.log(pc.dim("─".repeat(header.length)));
  for (const item of items) {
    const verified = isVerified(item);
    const name = pc.cyan(item.name.padEnd(maxName));
    const mark = verified
      ? pc.green("✓".padEnd(verifiedCol.length))
      : " ".repeat(verifiedCol.length);
    const desc = item.description ?? item.title ?? "";
    console.log(`${name}  ${mark}  ${verified ? desc : pc.dim(desc)}`);
  }
}

async function runList(opts: {
  json?: boolean;
  verified?: boolean;
}): Promise<void> {
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
      pc.red(
        `Could not read the registry index from ${REGISTRY_REPO} (HTTP ${res.status}).`,
      ),
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
  let items = data.items ?? [];
  if (opts.verified) {
    items = items.filter(isVerified);
  }

  if (opts.json) {
    // Surface `verified` as a top-level field for easy scripting.
    console.log(
      JSON.stringify(
        items.map((i) => ({ ...i, verified: isVerified(i) })),
        null,
        2,
      ),
    );
  } else {
    printTable(items);
  }
}

export const registryListCommand = new Command("list")
  .description("List items available in the AppKit registry")
  .option("--json", "Output as JSON")
  .option("--verified", "Show only verified items")
  .action((opts: { json?: boolean; verified?: boolean }) =>
    runList(opts).catch((err) => {
      console.error(err);
      process.exit(1);
    }),
  );
