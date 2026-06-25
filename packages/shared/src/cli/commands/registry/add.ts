import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Command } from "commander";
import {
  REGISTRY_ITEM_API_TEMPLATE,
  REGISTRY_ITEM_URL_TEMPLATE,
  REGISTRY_NAMESPACE,
  REGISTRY_REPO,
  type RegistryToken,
  resolveToken,
} from "./constants";

function stripNamespace(component: string): string {
  const prefix = `${REGISTRY_NAMESPACE}/`;
  return component.startsWith(prefix)
    ? component.slice(prefix.length)
    : component;
}

/**
 * Fetches a single registry item and writes it to a temp file, returning the
 * path. When a token is present the GitHub Contents API is used (works for the
 * private/internal repo); otherwise the public raw URL is used. We fetch it
 * ourselves — rather than relying on a shadcn registry namespace — so we fully
 * control the auth headers, then hand the local file to `shadcn add`.
 */
async function fetchItem(
  name: string,
  token: RegistryToken | null,
): Promise<string> {
  const template = token
    ? REGISTRY_ITEM_API_TEMPLATE
    : REGISTRY_ITEM_URL_TEMPLATE;
  const url = template.replace("{name}", name);
  const headers: Record<string, string> = {};
  if (token) {
    headers.Authorization = `Bearer ${token.value}`;
    headers.Accept = "application/vnd.github.raw";
  }

  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetch(url, { headers });
  } catch (err) {
    console.error(`Failed to fetch "${name}" from ${url}`);
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (res.status === 404) {
    console.error(`Component "${name}" not found in ${REGISTRY_REPO}.`);
    if (!token) {
      console.error(
        "  If the registry repo is private, set APPKIT_REGISTRY_TOKEN (or GITHUB_TOKEN) to a token with read access.",
      );
    }
    process.exit(1);
  }
  if (res.status === 401 || res.status === 403) {
    console.error(
      `Access denied (HTTP ${res.status}) fetching "${name}" from ${REGISTRY_REPO}.`,
    );
    console.error("  Check that your token has read access to the repository.");
    process.exit(1);
  }
  if (!res.ok) {
    console.error(`Registry returned HTTP ${res.status} for "${name}".`);
    process.exit(1);
  }

  const body = await res.text();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "appkit-registry-"));
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(file, body);
  return file;
}

async function runAdd(
  components: string[],
  opts: { yes?: boolean },
): Promise<void> {
  const cwd = process.cwd();
  if (!fs.existsSync(path.join(cwd, "components.json"))) {
    console.error(`No components.json found in ${cwd}.`);
    console.error(
      "  Run `npx shadcn@latest init` first, or run this from your app root.",
    );
    process.exit(1);
  }

  const token = resolveToken();
  if (token) {
    console.log(
      `Using ${token.envName} to fetch from ${REGISTRY_REPO} (private).`,
    );
  }

  const names = components.map(stripNamespace);
  const tmpFiles: string[] = [];
  for (const name of names) {
    tmpFiles.push(await fetchItem(name, token));
  }

  const args = ["shadcn@latest", "add", ...tmpFiles];
  if (opts.yes) args.push("--yes");
  const result = spawnSync("npx", args, { stdio: "inherit", cwd });

  for (const file of tmpFiles) {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }

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
While the registry repo is private, a token with read access is used. It is
resolved automatically from \`gh auth token\` (if you're logged in with the
GitHub CLI), or from APPKIT_REGISTRY_TOKEN / GITHUB_TOKEN / GH_TOKEN.

Examples:
  $ appkit add metric-card
  $ appkit add metric-card data-table
  $ appkit add @appkit/metric-card`,
  )
  .action((components: string[], opts: { yes?: boolean }) =>
    runAdd(components, opts).catch((err) => {
      console.error(err);
      process.exit(1);
    }),
  );
