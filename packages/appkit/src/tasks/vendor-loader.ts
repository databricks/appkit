import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { InitializationError } from "../errors";

/** Type-only import keeps `import "@databricks/appkit"` from touching the native binary. */
type VendorModule = typeof import("../../vendor/taskflow/taskflow.js");

let cachedVendor: VendorModule | null = null;

/**
 * Returns the loaded vendor module without awaiting — `null` until
 * {@link loadVendorModule} has resolved at least once. Callers must
 * already be inside a task body (where the engine has booted).
 * @internal
 */
export function getCachedVendorSync(): VendorModule | null {
  return cachedVendor;
}

interface VendorManifest {
  name?: string;
  version?: string;
  description?: string;
  platforms?: Record<string, { file: string; sha256: string }>;
  loader?: { file: string; sha256: string };
  types?: { file: string; sha256: string };
}

/**
 * Lazy-loads the vendored binary so apps that do not enable tasks never need
 * a prebuilt binary for the current platform.
 *
 * Integrity is verified by default in `NODE_ENV=production` and skipped
 * elsewhere. Override with `APPKIT_VERIFY_TASKFLOW_VENDOR=1` / `=0`.
 *
 * @internal
 */
export async function loadVendorModule(): Promise<VendorModule> {
  if (cachedVendor) return cachedVendor;
  try {
    if (shouldVerifyVendor()) await verifyVendorIntegrity();
    cachedVendor = (await import(
      "../../vendor/taskflow/taskflow.js"
    )) as VendorModule;
    return cachedVendor;
  } catch (err) {
    if (err instanceof InitializationError) throw err;
    const message = (err as { message?: string } | undefined)?.message ?? err;
    throw new InitializationError(
      `TaskFlow native binary unavailable for ${process.platform}-${process.arch}: ${message}`,
      { cause: err instanceof Error ? err : undefined },
    );
  }
}

function shouldVerifyVendor(): boolean {
  const override = process.env.APPKIT_VERIFY_TASKFLOW_VENDOR;
  if (override === "1") return true;
  if (override === "0") return false;
  return process.env.NODE_ENV === "production";
}

/**
 * Verifies the platform `.node` and JS loader against `VENDOR.json`.
 * Throws `InitializationError` on mismatch so a tampered binary never
 * reaches the runtime.
 */
async function verifyVendorIntegrity(): Promise<void> {
  const vendorDir = await resolveVendorDir();
  const manifest = await loadManifest(vendorDir);
  const platformKey = `${process.platform}-${process.arch}`;
  const platform = manifest.platforms?.[platformKey];

  if (!platform && !manifest.loader) {
    throwIntegrityError(
      `VENDOR.json has no entries for ${platformKey} and no loader manifest.`,
    );
  }

  if (platform) {
    await verifyFile(
      join(vendorDir, platform.file),
      platform.sha256,
      `binary (${platformKey})`,
    );
  }
  if (manifest.loader) {
    await verifyFile(
      join(vendorDir, manifest.loader.file),
      manifest.loader.sha256,
      "loader",
    );
  }
}

/**
 * Locates the vendor directory at runtime. The folder sits at a
 * different relative depth in source vs. published builds, so we
 * probe the known candidates and return the first that exists.
 */
async function resolveVendorDir(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "..", "vendor", "taskflow"),
    join(here, "..", "appkit", "vendor", "taskflow"),
  ];
  for (const candidate of candidates) {
    if (await exists(join(candidate, "VENDOR.json"))) return candidate;
  }
  throwIntegrityError(
    `VENDOR.json not found under any of: ${candidates.join(", ")}`,
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function loadManifest(vendorDir: string): Promise<VendorManifest> {
  const raw = await readFile(join(vendorDir, "VENDOR.json"), "utf8");
  return JSON.parse(raw) as VendorManifest;
}

async function verifyFile(
  path: string,
  expected: string,
  label: string,
): Promise<void> {
  const buf = await readFile(path);
  const actual = createHash("sha256").update(buf).digest("hex");
  if (actual !== expected) {
    throwIntegrityError(
      `${label} sha256 mismatch.\n  expected: ${expected}\n  actual:   ${actual}`,
    );
  }
}

function throwIntegrityError(reason: string): never {
  throw new InitializationError(
    `TaskFlow vendor integrity check failed: ${reason}`,
  );
}
