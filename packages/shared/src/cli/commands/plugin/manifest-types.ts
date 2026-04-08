/**
 * Shared types for plugin manifests used across CLI commands.
 * Base types (ResourceFieldEntry, ResourceRequirement, PluginManifest) are
 * generated from plugin-manifest.schema.json — only CLI-specific extensions
 * (TemplatePlugin, TemplatePluginsManifest) are hand-written here.
 */

export type {
  DiscoveryDescriptor,
  PluginManifest,
  PostScaffoldStep,
  ResourceFieldEntry,
  ResourceRequirement,
} from "../../../schemas/plugin-manifest.generated";

import type {
  PluginManifest,
  PostScaffoldStep,
} from "../../../schemas/plugin-manifest.generated";

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

export type Origin = "user" | "platform" | "static" | "cli";

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
