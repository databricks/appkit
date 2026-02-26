/**
 * Shared types for plugin manifests used across CLI commands.
 * Single source of truth for manifest structure — avoids duplicate
 * definitions in sync, validate, list, and add-resource commands.
 */

export interface ResourceFieldEntry {
  env: string;
  description?: string;
}

export interface ResourceRequirement {
  type: string;
  alias: string;
  resourceKey: string;
  description: string;
  permission: string;
  fields: Record<string, ResourceFieldEntry>;
}

export interface PluginManifest {
  name: string;
  displayName: string;
  description: string;
  resources: {
    required: ResourceRequirement[];
    optional: ResourceRequirement[];
  };
  config?: { schema: unknown };
  onSetupMessage?: string;
  hidden?: boolean;
}

export interface TemplatePlugin extends Omit<PluginManifest, "config"> {
  package: string;
  /** When true, this plugin is required by the template and cannot be deselected during CLI init. */
  requiredByTemplate?: boolean;
}

export interface TemplatePluginsManifest {
  $schema: string;
  version: string;
  plugins: Record<string, TemplatePlugin>;
}
