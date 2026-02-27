import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MANIFEST_JSON = "manifest.json";
const MANIFEST_JS = "manifest.js";
const MANIFEST_CJS = "manifest.cjs";

/** Resolution order for manifest files in a plugin directory. */
const MANIFEST_CANDIDATES = [MANIFEST_JSON, MANIFEST_JS, MANIFEST_CJS] as const;

export type ManifestFileType = "json" | "js";

export interface ResolvedManifest {
  /** Absolute path to the manifest file */
  path: string;
  /** How to load it: JSON (read + parse) or JS (dynamic import / require) */
  type: ManifestFileType;
}

export interface ManifestLoadOptions {
  /**
   * Allow loading JS manifests via import/require.
   * Disabled by default to avoid executing untrusted code.
   */
  allowJsManifest?: boolean;
}

/**
 * Resolve the manifest file in a plugin directory.
 * By default tries only manifest.json. If allowJsManifest=true, then also
 * tries manifest.js and manifest.cjs.
 *
 * @param pluginDir - Absolute path to the plugin directory
 * @returns The resolved file path and type, or null if none found
 */
export function resolveManifestInDir(
  pluginDir: string,
  options: ManifestLoadOptions = {},
): ResolvedManifest | null {
  const candidates = options.allowJsManifest
    ? MANIFEST_CANDIDATES
    : [MANIFEST_JSON];
  for (const name of candidates) {
    const manifestPath = path.join(pluginDir, name);
    if (fs.existsSync(manifestPath) && fs.statSync(manifestPath).isFile()) {
      return {
        path: path.resolve(manifestPath),
        type: name === MANIFEST_JSON ? "json" : "js",
      };
    }
  }
  return null;
}

/**
 * Load a manifest from a file (JSON or JS).
 * JSON: read and parse. JS: dynamic import (ESM) or require (CJS); the module must default-export the manifest object.
 *
 * @param manifestPath - Absolute path to manifest.json or manifest.js/.cjs
 * @param type - "json" or "js"
 * @returns The parsed manifest object (caller should validate with schema)
 */
export async function loadManifestFromFile(
  manifestPath: string,
  type: ManifestFileType,
  options: ManifestLoadOptions = {},
): Promise<unknown> {
  if (type === "json") {
    const raw = fs.readFileSync(manifestPath, "utf-8");
    return JSON.parse(raw) as unknown;
  }

  if (!options.allowJsManifest) {
    throw new Error(
      `Refusing to execute JS manifest at ${manifestPath}. Pass --allow-js-manifest to opt in.`,
    );
  }

  const ext = path.extname(manifestPath).toLowerCase();
  if (ext === ".cjs") {
    const require = createRequire(import.meta.url);
    const mod = require(manifestPath);
    return mod?.default ?? mod;
  }

  const url = pathToFileURL(manifestPath).href;
  const mod = await import(url);
  return mod?.default ?? mod;
}
