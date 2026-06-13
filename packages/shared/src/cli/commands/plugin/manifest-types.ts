/**
 * Thin re-export shim for plugin manifest types used across CLI commands.
 *
 * Source of truth is the Zod schema module (`../../../schemas/manifest`); all
 * type aliases and the Standard Schema interface re-export from there. This
 * shim only exists so existing callers (`sync.ts`, `validate.ts`, `create.ts`,
 * `add-resource.ts`, etc.) continue importing from the same path.
 */

export type { StandardSchemaV1 } from "@standard-schema/spec";
export type {
  DiscoveryDescriptor,
  Origin,
  PluginManifest,
  PluginScaffoldingRules,
  ResourceFieldEntry,
  ResourceKind,
  ResourceRequirement,
  ScaffoldingDescriptor,
  ScaffoldingFlag,
  ScaffoldingRules,
  TemplatePlugin,
  TemplatePluginsManifest,
} from "../../../schemas/manifest";
