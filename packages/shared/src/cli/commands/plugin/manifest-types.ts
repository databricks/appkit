/**
 * Thin re-export shim for plugin manifest types used across CLI commands.
 *
 * Phase 5: source of truth is the Zod schema module (`../../../schemas/manifest`).
 * All type aliases and the Standard Schema interface re-export from there. The
 * legacy `plugin-manifest.generated.ts` is gone; kept this shim only so existing
 * callers (`sync.ts`, `validate.ts`, `create.ts`, `add-resource.ts`, etc.)
 * continue importing from the same path without rewrite.
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
