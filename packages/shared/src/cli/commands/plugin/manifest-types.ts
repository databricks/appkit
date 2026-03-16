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

import type { PluginManifest } from "../../../schemas/plugin-manifest.generated";

export interface ScaffoldingFlag {
  required: boolean;
  description: string;
  pattern?: string;
  default?: string;
}

export interface ScaffoldingDescriptor {
  command: string;
  flags: Record<string, ScaffoldingFlag>;
  rules: string[];
}

export interface TemplatePlugin extends Omit<PluginManifest, "config"> {
  package: string;
  /** When true, this plugin is required by the template and cannot be deselected during CLI init. */
  requiredByTemplate?: boolean;
}

export interface TemplatePluginsManifest {
  $schema: string;
  version: string;
  scaffolding: ScaffoldingDescriptor;
  plugins: Record<string, TemplatePlugin>;
}
