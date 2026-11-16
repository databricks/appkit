import process from "node:process";

import {
  REGISTRY_INDEX_URL,
  REGISTRY_ITEM_URL_TEMPLATE,
  REGISTRY_NAMESPACE,
  REGISTRY_REPO,
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
 * A registry item name is a slug: letters, digits, dot, underscore, hyphen —
 * never a path separator or `.`/`..`. Names come from user refs and from an
 * item's untrusted `registryDependencies`, and are used both as the fetch path
 * (`public/r/<name>.json`) and as the on-disk `plugins/<name>` dir. Rejecting
 * separators and dot-segments at the source stops a crafted ref like
 * `../../attacker/repo/payload` from redirecting the fetch to another path in
 * the registry repo or escaping the destination dir, and keeps control chars
 * out of any printed name.
 */
const ITEM_NAME = /^[A-Za-z0-9._-]+$/;

/** True when `name` is a safe registry item slug (post-namespace-strip). */
export function isValidItemName(name: string): boolean {
  return name !== "." && name !== ".." && ITEM_NAME.test(name);
}

/**
 * Fetches and parses a single registry item from the public raw URL. Exits the
 * process with a helpful message on failure.
 */
export async function fetchRegistryItem(name: string): Promise<RegistryItem> {
  const url = REGISTRY_ITEM_URL_TEMPLATE.replace("{name}", name);

  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetch(url);
  } catch (err) {
    console.error(`Failed to fetch "${name}" from ${url}`);
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (res.status === 404) {
    console.error(`"${name}" not found in ${REGISTRY_REPO}.`);
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
export async function fetchVerifiedNames(): Promise<Set<string> | null> {
  try {
    const res = await fetch(REGISTRY_INDEX_URL);
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
