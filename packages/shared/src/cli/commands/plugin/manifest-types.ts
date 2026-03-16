/**
 * Shared types for plugin manifests used across CLI commands.
 * Base types (ResourceFieldEntry, ResourceRequirement, PluginManifest) are
 * generated from plugin-manifest.schema.json — only CLI-specific extensions
 * (TemplatePlugin, TemplatePluginsManifest) are hand-written here.
 */

export type {
  PluginManifest,
  ResourceFieldEntry,
  ResourceRequirement,
} from "../../../schemas/plugin-manifest.generated";

import type {
  PluginManifest as GeneratedPluginManifest,
  ResourceFieldEntry as GeneratedResourceFieldEntry,
} from "../../../schemas/plugin-manifest.generated";

export type DiscoveryDescriptor = NonNullable<
  GeneratedResourceFieldEntry["discovery"]
>;
export type ResourceResolution = NonNullable<
  GeneratedResourceFieldEntry["resolution"]
>;
export type PostScaffoldStep = NonNullable<
  GeneratedPluginManifest["postScaffold"]
>[number];

export interface ScaffoldingFlagDescriptor {
  required: boolean;
  description: string;
  pattern?: string;
  default?: string;
}

export interface ScaffoldingDescriptor {
  command: string;
  flags: Record<string, ScaffoldingFlagDescriptor>;
  rules: string[];
}

export interface TemplatePlugin
  extends Omit<GeneratedPluginManifest, "config"> {
  package: string;
  /** When true, this plugin is required by the template and cannot be deselected during CLI init. */
  requiredByTemplate?: boolean;
}

export interface TemplatePluginsManifest {
  $schema: string;
  version: string;
  scaffolding?: ScaffoldingDescriptor;
  plugins: Record<string, TemplatePlugin>;
}
