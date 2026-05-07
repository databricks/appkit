/**
 * Shared types for plugin manifests used across CLI commands.
 *
 * Phase 4 update: `DiscoveryDescriptor`, `ResourceFieldEntry`,
 * `ResourceRequirement`, `PluginManifest`, and `PostScaffoldStep` are now
 * sourced from the Zod schema module (the canonical contract). The legacy
 * `plugin-manifest.generated.ts` types are stale because the discovery
 * contract reshaped to a discriminated union; re-exporting from there would
 * drop the union and break downstream type checks. CLI-specific extensions
 * (`TemplatePlugin`, `TemplatePluginsManifest`) are still hand-written here
 * — Phase 5 will fold those into the Zod module and delete this shim.
 */

export type {
  DiscoveryDescriptor,
  PluginManifest,
  PostScaffoldStep,
  ResourceFieldEntry,
  ResourceRequirement,
} from "../../../schemas/manifest";

import type {
  PluginManifest,
  PostScaffoldStep,
} from "../../../schemas/manifest";

export interface ScaffoldingFlag {
  description: string;
  required?: boolean;
  pattern?: string;
  default?: string;
}

export interface ScaffoldingRules {
  never?: string[];
  must?: string[];
}

export interface ScaffoldingDescriptor {
  command: string;
  flags?: Record<string, ScaffoldingFlag>;
  rules?: ScaffoldingRules;
}

export interface TemplatePlugin extends Omit<PluginManifest, "config"> {
  package: string;
  /** When true, this plugin is required by the template and cannot be deselected during CLI init. */
  requiredByTemplate?: boolean;
  /** Plugin stability level. Absent or undefined means "ga" (general availability). */
  stability?: "beta" | "ga";
  /** Ordered list of post-scaffolding instructions propagated from the plugin manifest. */
  postScaffold?: PostScaffoldStep[];
}

export interface TemplatePluginsManifest {
  $schema: string;
  version: string;
  plugins: Record<string, TemplatePlugin>;
  scaffolding?: ScaffoldingDescriptor;
}
