import process from "node:process";
import {
  REGISTRY_INDEX_API_URL,
  REGISTRY_INDEX_URL,
  REGISTRY_ITEM_API_TEMPLATE,
  REGISTRY_ITEM_URL_TEMPLATE,
  REGISTRY_NAMESPACE,
  REGISTRY_REPO,
  type RegistryToken,
} from "./constants";

export interface RegistryItemFile {
  path: string;
  content: string;
  type: string;
  /** Destination path relative to the project root. */
  target?: string;
}

export interface RegistryItem {
  name: string;
  type?: string;
  dependencies?: string[];
  registryDependencies?: string[];
  files?: RegistryItemFile[];
}

/** Removes a leading `@databricks-appkit/` namespace from a component reference. */
export function stripNamespace(component: string): string {
  const prefix = `${REGISTRY_NAMESPACE}/`;
  return component.startsWith(prefix)
    ? component.slice(prefix.length)
    : component;
}

/**
 * Fetches and parses a single registry item. When a token is present the GitHub
 * Contents API is used (works for the private/internal repo); otherwise the
 * public raw URL is used. Exits the process with a helpful message on failure.
 */
export async function fetchRegistryItem(
  name: string,
  token: RegistryToken | null,
): Promise<RegistryItem> {
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
    console.error(`"${name}" not found in ${REGISTRY_REPO}.`);
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

  return (await res.json()) as RegistryItem;
}

/** One entry in the registry index (`registry.json`). */
export interface RegistryIndexEntry {
  name: string;
  meta?: { verified?: boolean };
}

/**
 * Fetches the registry index (`registry.json`) and returns the set of item
 * names marked `meta.verified`. The `verified` flag lives only in the index —
 * the per-item JSON at `public/r/<name>.json` does not carry it — so the `add`
 * integrity gate must consult this. Returns null (not an empty set) if the
 * index can't be read, so the caller can tell "nothing verified" apart from
 * "couldn't check".
 */
export async function fetchVerifiedNames(
  token: RegistryToken | null,
): Promise<Set<string> | null> {
  const url = token ? REGISTRY_INDEX_API_URL : REGISTRY_INDEX_URL;
  const headers: Record<string, string> = {};
  if (token) {
    headers.Authorization = `Bearer ${token.value}`;
    headers.Accept = "application/vnd.github.raw";
  }
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    const data = (await res.json()) as { items?: RegistryIndexEntry[] };
    const verified = new Set<string>();
    for (const item of data.items ?? []) {
      if (item.meta?.verified === true) verified.add(item.name);
    }
    return verified;
  } catch {
    return null;
  }
}
