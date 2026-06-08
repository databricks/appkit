/**
 * Zod-authoring module for AppKit plugin manifest schemas.
 *
 * Single source of truth for the plugin manifest contract. JSON Schema
 * artifacts published at the docs URL are emitted from these schemas via
 * `tools/generate-json-schema.ts` and live only in `docs/static/schemas/`
 * (no package-internal copies).
 *
 * - Cross-field constraints (cycle/dangling-reference checks, `<PROFILE>`
 *   placeholder, post-scaffold instruction non-empty) are refinements
 *   co-located with the shape they constrain. Validation is driven through
 *   the Standard Schema interface from `validate-manifest.ts`.
 * - `templateFieldEntrySchema` is a transform that emits `origin` from
 *   `localOnly`/`value`/`resolve`. The input slot is still allowed so
 *   re-parsing previously-synced template manifests does not fail, but the
 *   transform always overwrites it — drift-by-construction for hand-edits.
 * - `discoveryDescriptorSchema` is a discriminated union over a `type`
 *   literal. The `kind` variant references one of the well-known
 *   `resourceKind` values for which AppKit owns the CLI command map (see
 *   `RESOURCE_KIND_COMMANDS` below). The `cli` variant is the escape hatch
 *   carrying the existing free-form fields (with the `<PROFILE>`
 *   refinement). Hierarchical context for volumes (catalog/schema parent
 *   walk) is encoded via the kind's `parents` array, not via dependsOn.
 * - Scaffolding rule items carry a `maxLength` (120 chars) so
 *   `rules.never[]` / `rules.must[]` / `rules.should[]` stay short
 *   directives by contract, and the canonical `TEMPLATE_SCAFFOLDING`
 *   constant lives co-located with the scaffolding schemas (sync.ts
 *   imports it).
 */

import { z } from "zod";

// ── Resource type + per-type permission enums ────────────────────────────

export const resourceTypeSchema = z
  .enum([
    "secret",
    "job",
    "sql_warehouse",
    "serving_endpoint",
    "volume",
    "vector_search_index",
    "uc_function",
    "uc_connection",
    "database",
    "postgres",
    "genie_space",
    "experiment",
    "app",
  ])
  .describe("Type of Databricks resource");

export const secretPermissionSchema = z
  .enum(["READ", "WRITE", "MANAGE"])
  .describe("Permission for secret resources (order: weakest to strongest)");

export const jobPermissionSchema = z
  .enum(["CAN_VIEW", "CAN_MANAGE_RUN", "CAN_MANAGE"])
  .describe("Permission for job resources (order: weakest to strongest)");

export const sqlWarehousePermissionSchema = z
  .enum(["CAN_USE", "CAN_MANAGE"])
  .describe(
    "Permission for SQL warehouse resources (order: weakest to strongest)",
  );

export const servingEndpointPermissionSchema = z
  .enum(["CAN_VIEW", "CAN_QUERY", "CAN_MANAGE"])
  .describe(
    "Permission for serving endpoint resources (order: weakest to strongest)",
  );

export const volumePermissionSchema = z
  .enum(["READ_VOLUME", "WRITE_VOLUME"])
  .describe("Permission for Unity Catalog volume resources");

export const vectorSearchIndexPermissionSchema = z
  .enum(["SELECT"])
  .describe("Permission for vector search index resources");

export const ucFunctionPermissionSchema = z
  .enum(["EXECUTE"])
  .describe("Permission for Unity Catalog function resources");

export const ucConnectionPermissionSchema = z
  .enum(["USE_CONNECTION"])
  .describe("Permission for Unity Catalog connection resources");

export const databasePermissionSchema = z
  .enum(["CAN_CONNECT_AND_CREATE"])
  .describe("Permission for database resources");

export const postgresPermissionSchema = z
  .enum(["CAN_CONNECT_AND_CREATE"])
  .describe("Permission for Postgres resources");

export const genieSpacePermissionSchema = z
  .enum(["CAN_VIEW", "CAN_RUN", "CAN_EDIT", "CAN_MANAGE"])
  .describe(
    "Permission for Genie Space resources (order: weakest to strongest)",
  );

export const experimentPermissionSchema = z
  .enum(["CAN_READ", "CAN_EDIT", "CAN_MANAGE"])
  .describe(
    "Permission for MLflow experiment resources (order: weakest to strongest)",
  );

export const appPermissionSchema = z
  .enum(["CAN_USE"])
  .describe("Permission for Databricks App resources");

// ── Discovery descriptor (discriminated union) ───────────────────────────

/**
 * Well-known Databricks resource kinds for which AppKit owns the CLI
 * command map. Plugins reference one of these via the `kind` variant of the
 * discovery descriptor; everything else falls back to the free-form `cli`
 * variant.
 *
 * Kept narrow on purpose: each entry costs an addition to
 * `RESOURCE_KIND_COMMANDS` below, which is the single source of truth for
 * how that kind is enumerated.
 */
export const resourceKindSchema = z
  .enum([
    "warehouse",
    "genie_space",
    "postgres_project",
    "postgres_branch",
    "postgres_database",
    "volume",
  ])
  .describe(
    "Well-known Databricks resource kind whose listing command is owned by AppKit (see RESOURCE_KIND_COMMANDS).",
  );

export const kindDiscoveryDescriptorSchema = z
  .object({
    type: z
      .literal("kind")
      .describe(
        "Discriminator: 'kind' uses the AppKit-owned command map for the named resourceKind.",
      ),
    resourceKind: resourceKindSchema.describe(
      "Reference to a well-known Databricks resource kind. AppKit owns the CLI command, response shape, and unwrap rules.",
    ),
    select: z
      .string()
      .optional()
      .describe(
        "Field name in the parsed CLI response used as the selected value (e.g., 'id'). Defaults to the kind's natural identifier when omitted.",
      ),
    display: z
      .string()
      .optional()
      .describe(
        "Field name in the parsed CLI response shown to the user in selection UI. Defaults to `select` if omitted.",
      ),
    dependsOn: z
      .string()
      .optional()
      .describe(
        "Name of a sibling field within the same resource that must be resolved first. Used to express ordering dependencies between resource fields.",
      ),
    shortcut: z
      .string()
      .optional()
      .describe(
        "Single-value fast-path command that returns exactly one value, skipping interactive selection.",
      ),
  })
  .strict()
  .describe(
    "Discovery via a well-known resource kind. AppKit owns the CLI command and unwrap rules for the named kind.",
  );

/**
 * Shell metacharacters rejected on free-form CLI command strings. Catches the
 * common foot-guns (statement separators, pipes, redirects via shell, command
 * substitution, newlines). Not a security boundary on its own — executors must
 * always pass these via argv, never shell-exec the string. Angle brackets are
 * permitted because `<PROFILE>` (and future `<…>` placeholders) are part of
 * the command-template convention.
 */
const SHELL_METACHAR_RE = /[;|&`$\n\r]/;

export const cliDiscoveryDescriptorSchema = z
  .object({
    type: z
      .literal("cli")
      .describe(
        "Discriminator: 'cli' uses a free-form Databricks CLI command supplied by the plugin.",
      ),
    cliCommand: z
      .string()
      .describe(
        "Databricks CLI command that lists resources. Must include <PROFILE>. Shell metacharacters (;|&`$ and newlines) are rejected; for first-party Databricks resources prefer the `kind` variant which uses AppKit's typed command map.",
      ),
    selectField: z
      .string()
      .describe(
        "jq-style path to the field used as the selected value (e.g., '.id', '.name').",
      ),
    displayField: z
      .string()
      .optional()
      .describe(
        "jq-style path to the field shown to the user in selection UI. Defaults to selectField if omitted.",
      ),
    dependsOn: z
      .string()
      .optional()
      .describe(
        "Name of a sibling field within the same resource that must be resolved first. Used to express ordering dependencies between resource fields.",
      ),
    shortcut: z
      .string()
      .optional()
      .describe(
        "Single-value fast-path command that returns exactly one value, skipping interactive selection. Shell metacharacters are rejected.",
      ),
  })
  .strict()
  .refine((descriptor) => descriptor.cliCommand.includes("<PROFILE>"), {
    message: "must include <PROFILE> placeholder",
    path: ["cliCommand"],
  })
  .refine((descriptor) => !SHELL_METACHAR_RE.test(descriptor.cliCommand), {
    message:
      "must not contain shell metacharacters (;|&`$ or newlines); use the `kind` variant for typed Databricks resources",
    path: ["cliCommand"],
  })
  .refine(
    (descriptor) =>
      descriptor.shortcut === undefined ||
      !SHELL_METACHAR_RE.test(descriptor.shortcut),
    {
      message: "must not contain shell metacharacters (;|&`$ or newlines)",
      path: ["shortcut"],
    },
  )
  .describe(
    "Discovery via a free-form Databricks CLI command. Escape hatch — prefer the `kind` variant when a typed resourceKind covers the resource. This shape is intentionally minimal and may tighten further in future versions.",
  );

export const discoveryDescriptorSchema = z
  .discriminatedUnion("type", [
    kindDiscoveryDescriptorSchema,
    cliDiscoveryDescriptorSchema,
  ])
  .describe(
    "Describes how the CLI discovers values for a resource field. 'kind' references a well-known Databricks resource kind whose command is owned by AppKit; 'cli' is the escape hatch carrying a free-form Databricks CLI command.",
  );

// ── Resource kind → CLI command map ──────────────────────────────────────

/**
 * Descriptor for how a well-known resource kind is listed via the
 * Databricks CLI.
 *
 * - `command` is the CLI invocation template. It carries two kinds of
 *   placeholders:
 *     - `<PROFILE>` — substituted with the user's CLI profile by the runner.
 *     - `{<fieldName>}` — substituted with the resolved value of the named
 *       sibling field (used for `dependsOn` chains).
 * - `unwrap`, when set, is the JSON path into the response wrapper (e.g.,
 *   `"warehouses"` for `{ warehouses: [...] }`). Omitted when the response
 *   is already a flat array.
 * - `parents`, when set, lists transient query inputs the runner must
 *   collect (as free-text prompts) before invoking the command. Each
 *   `parents[i]` value substitutes the matching `{name}` placeholder in
 *   the command string. Unlike `dependsOn` (which references a sibling
 *   field on the same resource), `parents` covers inputs that aren't
 *   persisted as fields on the resource.
 */
export type ResourceKindCommand = {
  command: string;
  unwrap?: string;
  parents?: readonly string[];
};

/**
 * Single source of truth for AppKit-owned discovery commands.
 *
 * To add a new resource kind: extend `resourceKindSchema` and add an entry
 * here. Plugins reference the kind via `discovery: { type: "kind",
 * resourceKind: "..." }` and inherit the command + response shape.
 *
 * `unwrap` defaults are unset: the existing core plugin manifests use simple
 * jq paths (`.id`, `.name`, `.full_name`), implying the listed CLI commands
 * return flat arrays. Refine in a follow-up if a kind's CLI returns wrapped
 * data.
 *
 * Volume's catalog/schema parent context is supplied via the `parents`
 * array, which the runner collects from the user as free-text prompts
 * before invoking the listing command.
 */
export const RESOURCE_KIND_COMMANDS: Record<
  z.infer<typeof resourceKindSchema>,
  { command: string; unwrap?: string; parents?: readonly string[] }
> = {
  warehouse: {
    command: "databricks warehouses list --profile <PROFILE> --output json",
  },
  genie_space: {
    command: "databricks genie list-spaces --profile <PROFILE> --output json",
  },
  postgres_project: {
    command:
      "databricks postgres list-projects --profile <PROFILE> --output json",
  },
  postgres_branch: {
    // {project} is a placeholder for the resolved value of the `project`
    // sibling field (declared via `dependsOn: "project"` on the kind variant).
    // The Databricks CLI requires the parent project resource name (format
    // `projects/{project_id}`) as a positional argument.
    command:
      "databricks postgres list-branches {project} --profile <PROFILE> --output json",
  },
  postgres_database: {
    // {branch} is a placeholder for the resolved value of the `branch`
    // sibling field (declared via `dependsOn: "branch"` on the kind variant).
    command:
      "databricks postgres list-databases {branch} --profile <PROFILE> --output json",
  },
  volume: {
    // `parents` declares free-text user prompts the runner must collect before
    // invoking the discovery command. Each `parents[i]` value substitutes the
    // matching `{name}` placeholder in the command string above. Unlike
    // `dependsOn` (which references a sibling field on the same resource),
    // `parents` covers transient query inputs that aren't persisted as fields.
    command:
      "databricks volumes list {catalog} {schema} --profile <PROFILE> --output json",
    parents: ["catalog", "schema"] as const,
  },
};

// ── Resource field entry (plugin manifest variant) ───────────────────────

export const resourceFieldEntrySchema = z
  .object({
    env: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/)
      .optional()
      .describe("Environment variable name for this field"),
    description: z
      .string()
      .optional()
      .describe("Human-readable description for this field"),
    bundleIgnore: z
      .boolean()
      .optional()
      .describe(
        "When true, this field is excluded from Databricks bundle configuration (databricks.yml) generation.",
      ),
    examples: z
      .array(z.string())
      .optional()
      .describe("Example values showing the expected format for this field"),
    localOnly: z
      .boolean()
      .optional()
      .describe(
        "When true, this field is only generated for local .env files. The Databricks Apps platform auto-injects it at deploy time.",
      ),
    value: z
      .string()
      .optional()
      .describe(
        "Static value for this field. Used when no prompted or resolved value exists.",
      ),
    resolve: z
      .string()
      .regex(/^[a-z_]+:[a-zA-Z]+$/)
      .optional()
      .describe(
        "Named resolver prefixed by resource type (e.g., 'postgres:host'). The CLI resolves this value during the init prompt flow.",
      ),
    discovery: discoveryDescriptorSchema.optional(),
  })
  .strict()
  .describe(
    "Defines a single field for a resource. Each field has its own environment variable and optional description. Single-value types use one key (e.g. id); multi-value types (database, secret) use multiple (e.g. instance_name, database_name or scope, key).",
  );

// ── Resource requirement (per-type permission discriminator) ─────────────

/**
 * Build a per-type variant. Each variant fixes `type` to a literal and constrains
 * `permission` to the matching enum, mirroring the existing JSON Schema's
 * `allOf + if/then` block. `fields` and the rest of the shape come from a
 * shared base.
 */
const resourceRequirementBaseShape = {
  alias: z
    .string()
    .min(1)
    .describe(
      "Human-readable label for UI/display only. Deduplication uses resourceKey, not alias.",
    ),
  resourceKey: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/)
    .describe(
      "Stable key for machine use: deduplication, env naming, composite keys, app.yaml. Required for registry lookup.",
    ),
  description: z
    .string()
    .min(1)
    .describe("Human-readable description of why this resource is needed"),
  fields: z
    .record(z.string(), resourceFieldEntrySchema)
    .refine((obj) => Object.keys(obj).length >= 1, {
      message: "fields must contain at least one entry",
    })
    .optional()
    .describe(
      "Map of field name to env and optional description. Single-value types use one key (e.g. id); multi-value (database, secret) use multiple (e.g. instance_name, database_name or scope, key).",
    ),
};

/**
 * Adds the cycle/dangling-reference cross-field check to a resource variant.
 * Iterates the resource's `fields`, validates each `discovery.dependsOn` target
 * is a sibling field name, then runs DFS over the dependsOn graph to detect
 * cycles. Issue paths target either the offending field's `dependsOn` slot or
 * the resource itself for cycles.
 */
function refineResourceDependsOn(
  resource: { fields?: Record<string, { discovery?: { dependsOn?: string } }> },
  ctx: z.core.$RefinementCtx,
): void {
  if (!resource.fields) return;
  const fieldNames = new Set(Object.keys(resource.fields));

  // Pass 1: validate dependsOn references and build the dependency graph.
  const deps = new Map<string, string>();
  for (const [name, field] of Object.entries(resource.fields)) {
    const dep = field.discovery?.dependsOn;
    if (!dep) continue;
    if (!fieldNames.has(dep)) {
      ctx.addIssue({
        code: "custom",
        path: ["fields", name, "discovery", "dependsOn"],
        message: `references non-existent sibling field '${dep}'`,
      });
    }
    deps.set(name, dep);
  }

  // Pass 2: detect cycles via DFS. Emit one issue per cycle found.
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function dfs(node: string, chain: string[]): string[] | null {
    if (visiting.has(node)) return [...chain, node];
    if (visited.has(node)) return null;
    visiting.add(node);
    const next = deps.get(node);
    if (next) {
      const cycle = dfs(next, [...chain, node]);
      if (cycle) return cycle;
    }
    visiting.delete(node);
    visited.add(node);
    return null;
  }

  for (const node of deps.keys()) {
    if (visited.has(node)) continue;
    const cycle = dfs(node, []);
    if (cycle) {
      ctx.addIssue({
        code: "custom",
        path: [],
        message: `discovery.dependsOn creates a cycle: ${cycle.join(" → ")}`,
      });
      // One cycle error per resource is enough.
      break;
    }
  }
}

function makeResourceVariant<
  TType extends z.ZodLiteral<string>,
  TPerm extends z.ZodTypeAny,
>(typeLiteral: TType, permission: TPerm) {
  return z
    .object({
      type: typeLiteral,
      ...resourceRequirementBaseShape,
      permission: permission.describe(
        "Required permission level. Validated per resource type.",
      ),
    })
    .strict()
    .superRefine(refineResourceDependsOn);
}

export const resourceRequirementSchema = z
  .discriminatedUnion("type", [
    makeResourceVariant(z.literal("secret"), secretPermissionSchema),
    makeResourceVariant(z.literal("job"), jobPermissionSchema),
    makeResourceVariant(
      z.literal("sql_warehouse"),
      sqlWarehousePermissionSchema,
    ),
    makeResourceVariant(
      z.literal("serving_endpoint"),
      servingEndpointPermissionSchema,
    ),
    makeResourceVariant(z.literal("volume"), volumePermissionSchema),
    makeResourceVariant(
      z.literal("vector_search_index"),
      vectorSearchIndexPermissionSchema,
    ),
    makeResourceVariant(z.literal("uc_function"), ucFunctionPermissionSchema),
    makeResourceVariant(
      z.literal("uc_connection"),
      ucConnectionPermissionSchema,
    ),
    makeResourceVariant(z.literal("database"), databasePermissionSchema),
    makeResourceVariant(z.literal("postgres"), postgresPermissionSchema),
    makeResourceVariant(z.literal("genie_space"), genieSpacePermissionSchema),
    makeResourceVariant(z.literal("experiment"), experimentPermissionSchema),
    makeResourceVariant(z.literal("app"), appPermissionSchema),
  ])
  .describe(
    "Declares a resource requirement for a plugin. Can be defined statically in a manifest or dynamically via getResourceRequirements().",
  );

// ── Config schema (recursive) ────────────────────────────────────────────

export const configSchemaPropertySchema: z.ZodType = z.lazy(() =>
  z
    .object({
      type: z.enum([
        "object",
        "array",
        "string",
        "number",
        "boolean",
        "integer",
      ]),
      description: z.string().optional(),
      default: z.unknown().optional(),
      enum: z.array(z.unknown()).optional(),
      properties: z.record(z.string(), configSchemaPropertySchema).optional(),
      items: configSchemaPropertySchema.optional(),
      minimum: z.number().optional(),
      maximum: z.number().optional(),
      minLength: z.number().int().min(0).optional(),
      maxLength: z.number().int().min(0).optional(),
      required: z.array(z.string()).optional(),
      // `additionalProperties` is a standard JSON Schema keyword used by core
      // plugin manifests (e.g., serving, vector-search, genie) to constrain
      // dictionary-shaped properties. Allowed on nested property entries as
      // either a boolean or a sub-schema, mirroring JSON Schema semantics.
      additionalProperties: z
        .union([z.boolean(), configSchemaPropertySchema])
        .optional(),
    })
    .strict(),
);

export const configSchemaSchema: z.ZodType = z.lazy(() =>
  z
    .object({
      type: z.enum(["object", "array", "string", "number", "boolean"]),
      properties: z.record(z.string(), configSchemaPropertySchema).optional(),
      items: configSchemaSchema.optional(),
      required: z.array(z.string()).optional(),
      additionalProperties: z.boolean().optional(),
    })
    .strict(),
);

// ── Plugin-level scaffolding rules ───────────────────────────────────────

/**
 * Per-item upper bound on plugin-level scaffolding rule strings. Matches the
 * template-level `SCAFFOLDING_RULE_MAX_LENGTH` defined below — rules at both
 * levels are short directives, not prose. The literal value lives here (and
 * not by reference to the template-side constant) because this declaration
 * is read in source order and the template constant is declared later.
 */
const PLUGIN_SCAFFOLDING_RULE_MAX_LENGTH = 120;

const pluginScaffoldingRuleItemSchema = z
  .string()
  .min(1)
  .max(
    PLUGIN_SCAFFOLDING_RULE_MAX_LENGTH,
    `rule entries must be ≤ ${PLUGIN_SCAFFOLDING_RULE_MAX_LENGTH} chars`,
  );

export const pluginScaffoldingRulesSchema = z
  .object({
    must: z
      .array(pluginScaffoldingRuleItemSchema)
      .optional()
      .describe("Actions the scaffolding agent must always perform."),
    should: z
      .array(pluginScaffoldingRuleItemSchema)
      .optional()
      .describe("Recommended actions for the scaffolding agent."),
    never: z
      .array(pluginScaffoldingRuleItemSchema)
      .optional()
      .describe("Actions the scaffolding agent must never perform."),
  })
  .strict()
  .superRefine((rules, ctx) => {
    // (a) Reject duplicate entries within any single array.
    const buckets: Array<["must" | "should" | "never", string[] | undefined]> =
      [
        ["must", rules.must],
        ["should", rules.should],
        ["never", rules.never],
      ];
    for (const [bucketName, items] of buckets) {
      if (!items) continue;
      const seen = new Map<string, number>();
      items.forEach((item, idx) => {
        const prev = seen.get(item);
        if (prev === undefined) {
          seen.set(item, idx);
          return;
        }
        ctx.addIssue({
          code: "custom",
          path: [bucketName, idx],
          message: `duplicate rule entry: "${item}" already declared at index ${prev}`,
        });
      });
    }
    // (b) Reject a string that appears in more than one of must/should/never.
    type Bucket = "must" | "should" | "never";
    const owner = new Map<string, Bucket>();
    for (const [bucketName, items] of buckets) {
      if (!items) continue;
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const existing = owner.get(item);
        if (existing === undefined) {
          owner.set(item, bucketName);
          continue;
        }
        if (existing !== bucketName) {
          ctx.addIssue({
            code: "custom",
            path: [bucketName, i],
            message: `rule entry "${item}" appears in both '${existing}' and '${bucketName}'; rules must belong to exactly one bucket`,
          });
        }
      }
    }
  })
  .describe(
    "Structured rules for scaffolding agents declared at the plugin level. Each rule is a short directive (≤120 chars).",
  );

// ── Plugin manifest (root) ───────────────────────────────────────────────

export const pluginManifestSchema = z
  .object({
    $schema: z
      .string()
      .optional()
      .describe("Reference to the JSON Schema for validation"),
    name: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/)
      .describe(
        "Plugin identifier. Must be lowercase, start with a letter, and contain only letters, numbers, and hyphens.",
      ),
    displayName: z
      .string()
      .min(1)
      .describe("Human-readable display name for UI and CLI"),
    description: z
      .string()
      .min(1)
      .describe("Brief description of what the plugin does"),
    resources: z
      .object({
        required: z
          .array(resourceRequirementSchema)
          .describe(
            "Resources that must be available for the plugin to function",
          ),
        optional: z
          .array(resourceRequirementSchema)
          .describe(
            "Resources that enhance functionality but are not mandatory",
          ),
      })
      .strict()
      .describe("Databricks resource requirements for this plugin"),
    config: z
      .object({
        schema: configSchemaSchema.optional(),
      })
      .strict()
      .optional()
      .describe("Configuration schema for the plugin"),
    author: z.string().optional().describe("Author name or organization"),
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?$/)
      .optional()
      .describe("Plugin version (semver format)"),
    repository: z
      .url()
      .optional()
      .describe("URL to the plugin's source repository"),
    keywords: z
      .array(z.string())
      .optional()
      .describe("Keywords for plugin discovery"),
    license: z.string().optional().describe("SPDX license identifier"),
    onSetupMessage: z
      .string()
      .optional()
      .describe(
        "Message displayed to the user after project initialization. Use this to inform about manual setup steps (e.g. environment variables, resource provisioning).",
      ),
    hidden: z
      .boolean()
      .optional()
      .describe(
        "When true, this plugin is excluded from the template plugins manifest (appkit.plugins.json) during sync.",
      ),
    stability: z
      .enum(["beta", "ga"])
      .optional()
      .describe(
        "Plugin stability level. Beta plugins may have breaking API changes between minor releases but are on a path to GA. GA (general availability) plugins follow semver strictly.",
      ),
    scaffolding: z
      .object({
        rules: pluginScaffoldingRulesSchema
          .optional()
          .describe(
            "Structured rules for scaffolding agents declared at the plugin level.",
          ),
      })
      .strict()
      .optional()
      .describe(
        "Plugin-level scaffolding metadata consumed by scaffolding agents. Symmetric with template-level `scaffolding`.",
      ),
  })
  .strict()
  .describe(
    "Schema for Databricks AppKit plugin manifest files. Defines plugin metadata, resource requirements, and configuration options.",
  );

// ── Origin enum ──────────────────────────────────────────────────────────

export const originSchema = z
  .enum(["user", "platform", "static", "cli"])
  .describe(
    "How the field value is determined. Computed during sync, not authored by plugin developers.",
  );

// ── Template field entry (origin computed by transform) ─────────────────

/**
 * Derives the canonical origin of a resource field value from its shape.
 *
 * - `localOnly: true` → `"platform"` (auto-injected by the Databricks Apps
 *   platform at deploy time; takes precedence over `value`/`resolve`).
 * - `value !== undefined` → `"static"` (hardcoded value).
 * - `resolve !== undefined` → `"cli"` (resolved by the CLI during init).
 * - else → `"user"` (user must provide the value at init time).
 *
 * Co-located with `templateFieldEntrySchema` because the transform is the
 * only consumer. Kept private so any other "origin computation" goes
 * through the schema rather than re-implementing the rules.
 */
function computeOriginFromField(field: {
  localOnly?: boolean;
  value?: string;
  resolve?: string;
}): z.infer<typeof originSchema> {
  if (field.localOnly) return "platform";
  if (field.value !== undefined) return "static";
  if (field.resolve !== undefined) return "cli";
  return "user";
}

/**
 * Template field entry: extends the plugin manifest field entry with an
 * optional `origin` input slot, then runs a `.transform()` that overwrites
 * `origin` with the computed value. Allowing `origin` on input means
 * re-parsing a previously-synced template manifest does not fail; emitting
 * `origin` always means hand-edits in synced JSON are silently corrected
 * on the next parse — drift-by-construction.
 */
export const templateFieldEntrySchema = resourceFieldEntrySchema
  .extend({ origin: originSchema.optional() })
  .transform((field) => ({
    ...field,
    origin: computeOriginFromField(field),
  }));

// ── Template resource requirement (uses templateFieldEntrySchema) ────────

const templateResourceRequirementBaseShape = {
  alias: z
    .string()
    .min(1)
    .describe("Human-readable label for UI/display only."),
  resourceKey: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/)
    .describe(
      "Stable key for machine use: deduplication, env naming, composite keys.",
    ),
  description: z
    .string()
    .min(1)
    .describe("Human-readable description of why this resource is needed"),
  fields: z
    .record(z.string(), templateFieldEntrySchema)
    .refine((obj) => Object.keys(obj).length >= 1, {
      message: "fields must contain at least one entry",
    })
    .optional()
    .describe("Map of field name to field entry with computed origin."),
};

function makeTemplateResourceVariant<
  TType extends z.ZodLiteral<string>,
  TPerm extends z.ZodTypeAny,
>(typeLiteral: TType, permission: TPerm) {
  return z
    .object({
      type: typeLiteral,
      ...templateResourceRequirementBaseShape,
      permission: permission.describe(
        "Required permission level. Validated per resource type.",
      ),
    })
    .strict()
    .superRefine(refineResourceDependsOn);
}

export const templateResourceRequirementSchema = z
  .discriminatedUnion("type", [
    makeTemplateResourceVariant(z.literal("secret"), secretPermissionSchema),
    makeTemplateResourceVariant(z.literal("job"), jobPermissionSchema),
    makeTemplateResourceVariant(
      z.literal("sql_warehouse"),
      sqlWarehousePermissionSchema,
    ),
    makeTemplateResourceVariant(
      z.literal("serving_endpoint"),
      servingEndpointPermissionSchema,
    ),
    makeTemplateResourceVariant(z.literal("volume"), volumePermissionSchema),
    makeTemplateResourceVariant(
      z.literal("vector_search_index"),
      vectorSearchIndexPermissionSchema,
    ),
    makeTemplateResourceVariant(
      z.literal("uc_function"),
      ucFunctionPermissionSchema,
    ),
    makeTemplateResourceVariant(
      z.literal("uc_connection"),
      ucConnectionPermissionSchema,
    ),
    makeTemplateResourceVariant(
      z.literal("database"),
      databasePermissionSchema,
    ),
    makeTemplateResourceVariant(
      z.literal("postgres"),
      postgresPermissionSchema,
    ),
    makeTemplateResourceVariant(
      z.literal("genie_space"),
      genieSpacePermissionSchema,
    ),
    makeTemplateResourceVariant(
      z.literal("experiment"),
      experimentPermissionSchema,
    ),
    makeTemplateResourceVariant(z.literal("app"), appPermissionSchema),
  ])
  .describe(
    "Resource requirement with template-specific field entries (includes computed origin).",
  );

// ── Template plugin (extends plugin manifest) ────────────────────────────

export const templatePluginSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/)
      .describe(
        "Plugin identifier. Must be lowercase, start with a letter, and contain only letters, numbers, and hyphens.",
      ),
    displayName: z
      .string()
      .min(1)
      .describe("Human-readable display name for UI and CLI"),
    description: z
      .string()
      .min(1)
      .describe("Brief description of what the plugin does"),
    package: z
      .string()
      .min(1)
      .describe("NPM package name that provides this plugin"),
    requiredByTemplate: z
      .boolean()
      .optional()
      .describe(
        "When true, this plugin is required by the template and cannot be deselected during CLI init. The user will only be prompted to configure its resources. When absent or false, the plugin is optional and the user can choose whether to include it.",
      ),
    onSetupMessage: z
      .string()
      .optional()
      .describe(
        "Message displayed to the user after project initialization. Use this to inform about manual setup steps (e.g. environment variables, resource provisioning).",
      ),
    stability: z
      .enum(["beta", "ga"])
      .optional()
      .describe(
        "Plugin stability level. Beta is heading to GA; APIs may change between minor releases. GA (general availability) follows semver.",
      ),
    scaffolding: z
      .object({
        rules: pluginScaffoldingRulesSchema
          .optional()
          .describe(
            "Structured rules for scaffolding agents propagated from the plugin manifest.",
          ),
      })
      .strict()
      .optional()
      .describe(
        "Plugin-level scaffolding metadata propagated from the plugin manifest.",
      ),
    resources: z
      .object({
        required: z
          .array(templateResourceRequirementSchema)
          .describe(
            "Resources that must be available for the plugin to function",
          ),
        optional: z
          .array(templateResourceRequirementSchema)
          .describe(
            "Resources that enhance functionality but are not mandatory",
          ),
      })
      .strict()
      .describe("Databricks resource requirements for this plugin"),
  })
  .strict()
  .describe("Plugin manifest with package source information");

// ── Scaffolding descriptor ───────────────────────────────────────────────

export const scaffoldingFlagSchema = z
  .object({
    description: z.string().describe("Human-readable description of the flag."),
    required: z.boolean().optional().describe("Whether this flag is required."),
    pattern: z
      .string()
      .optional()
      .describe("Regex pattern for validating the flag value."),
    default: z.string().optional().describe("Default value for this flag."),
  })
  .strict()
  .describe("A flag for the scaffolding command.");

/**
 * Per-item upper bound on scaffolding rule strings. The intent is to enforce
 * "short directive" by contract — long paragraphs fail validation and force
 * authors to split prose into discrete actionable items.
 */
const SCAFFOLDING_RULE_MAX_LENGTH = 120;

const scaffoldingRuleItemSchema = z
  .string()
  .max(
    SCAFFOLDING_RULE_MAX_LENGTH,
    `rule item must be ≤ ${SCAFFOLDING_RULE_MAX_LENGTH} chars`,
  );

export const scaffoldingRulesSchema = z
  .object({
    never: z
      .array(scaffoldingRuleItemSchema)
      .optional()
      .describe("Actions the scaffolding agent must never perform."),
    must: z
      .array(scaffoldingRuleItemSchema)
      .optional()
      .describe("Actions the scaffolding agent must always perform."),
    should: z
      .array(scaffoldingRuleItemSchema)
      .optional()
      .describe(
        "Recommended actions for the scaffolding agent (parity with plugin-level rules).",
      ),
  })
  .strict()
  .describe("Structured rules for scaffolding agents.");

export const scaffoldingDescriptorSchema = z
  .object({
    command: z
      .string()
      .describe("The scaffolding command (e.g., 'databricks apps init')."),
    flags: z
      .record(z.string(), scaffoldingFlagSchema)
      .optional()
      .describe("Map of flag name to flag descriptor."),
    rules: scaffoldingRulesSchema
      .optional()
      .describe("Structured rules for scaffolding agents."),
  })
  .strict()
  .describe(
    "Describes the scaffolding command, flags, and rules for project initialization.",
  );

/**
 * Canonical scaffolding descriptor for the `databricks apps init` command,
 * embedded in v2.0 template manifests to guide scaffolding agents.
 *
 * Co-located with `scaffoldingDescriptorSchema` so any change to the rule set
 * (or the schema's `maxLength` ceiling) shows up next to its consumer. The
 * `satisfies` annotation gives compile-time validation that the literal
 * matches the schema's input shape; if a `must`/`never` entry exceeds the
 * `maxLength` ceiling at runtime, `scaffoldingDescriptorSchema.parse` would
 * surface the breach in tests.
 */
export const TEMPLATE_SCAFFOLDING = {
  command: "databricks apps init",
  flags: {
    "--name": {
      description:
        "Project name — sets {{.projectName}} in package.json, databricks.yml, and .env. Required for non-interactive scaffolding.",
      required: true,
      pattern: "^[a-z][a-z0-9-]*$",
    },
    "--template": {
      description: "Template path (local directory or GitHub URL)",
      required: false,
    },
    "--version": {
      description: "AppKit version to use; defaults to auto-detected",
      required: false,
    },
    "--features": {
      description:
        "Plugins to enable (comma-separated, no spaces; must match keys in this manifest's plugins map)",
      required: false,
      pattern: "^[a-zA-Z0-9_-]+(,[a-zA-Z0-9_-]+)*$",
    },
    "--set": {
      description:
        "Set resource values (format: plugin.resourceKey.field=value, repeatable)",
      required: false,
    },
    "--output-dir": {
      description: "Directory to write the project to",
      required: false,
    },
    "--description": {
      description: "App description",
      required: false,
    },
    "--run": {
      description: "Run the app after creation (none, dev, dev-remote)",
      required: false,
    },
    "--auto-approve": {
      description:
        "Pass as a bare flag (no value) to skip prompts for optional resources. Not recommended for agent-driven init — conflicts with the 'ask user when in doubt' rule.",
      required: false,
    },
    "--profile": {
      description:
        "Databricks CLI profile to use for authentication (global flag)",
      required: false,
    },
  },
  rules: {
    must: [
      "Keep all secrets and credentials only in app.yaml, databricks.yml, and/or .env",
    ],
    should: ["ask user when in doubt of resource to use for plugin"],
    never: [
      "guess resources when multiple or no options are available",
      "embed secrets in files that will go to the client-bundle",
    ],
  },
} satisfies z.infer<typeof scaffoldingDescriptorSchema>;

// ── Template plugins manifest (root) ─────────────────────────────────────

export const templatePluginsManifestSchema = z
  .object({
    $schema: z
      .string()
      .optional()
      .describe("Reference to the JSON Schema for validation"),
    version: z
      .enum(["1.0", "1.1", "2.0"])
      .describe("Schema version for the template plugins manifest"),
    plugins: z
      .record(z.string(), templatePluginSchema)
      .describe("Map of plugin name to plugin manifest with package source"),
    scaffolding: scaffoldingDescriptorSchema
      .optional()
      .describe(
        "Describes the scaffolding command and its configuration for project initialization.",
      ),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.version === "2.0" && !value.scaffolding) {
      ctx.addIssue({
        code: "custom",
        path: ["scaffolding"],
        message: "scaffolding is required when version is '2.0'",
      });
    }
  })
  .describe(
    "Aggregated plugin manifest for AppKit templates. Read by Databricks CLI during init to discover available plugins and their resource requirements.",
  );

// ── Inferred types ───────────────────────────────────────────────────────

export type ResourceType = z.infer<typeof resourceTypeSchema>;
export type SecretPermission = z.infer<typeof secretPermissionSchema>;
export type JobPermission = z.infer<typeof jobPermissionSchema>;
export type SqlWarehousePermission = z.infer<
  typeof sqlWarehousePermissionSchema
>;
export type ServingEndpointPermission = z.infer<
  typeof servingEndpointPermissionSchema
>;
export type VolumePermission = z.infer<typeof volumePermissionSchema>;
export type VectorSearchIndexPermission = z.infer<
  typeof vectorSearchIndexPermissionSchema
>;
export type UcFunctionPermission = z.infer<typeof ucFunctionPermissionSchema>;
export type UcConnectionPermission = z.infer<
  typeof ucConnectionPermissionSchema
>;
export type DatabasePermission = z.infer<typeof databasePermissionSchema>;
export type PostgresPermission = z.infer<typeof postgresPermissionSchema>;
export type GenieSpacePermission = z.infer<typeof genieSpacePermissionSchema>;
export type ExperimentPermission = z.infer<typeof experimentPermissionSchema>;
export type AppPermission = z.infer<typeof appPermissionSchema>;
export type ResourceKind = z.infer<typeof resourceKindSchema>;
export type KindDiscoveryDescriptor = z.infer<
  typeof kindDiscoveryDescriptorSchema
>;
export type CliDiscoveryDescriptor = z.infer<
  typeof cliDiscoveryDescriptorSchema
>;
export type DiscoveryDescriptor = z.infer<typeof discoveryDescriptorSchema>;
export type ResourceFieldEntry = z.infer<typeof resourceFieldEntrySchema>;
export type ResourceRequirement = z.infer<typeof resourceRequirementSchema>;
export type ConfigSchemaProperty = z.infer<typeof configSchemaPropertySchema>;
export type ConfigSchema = z.infer<typeof configSchemaSchema>;
export type PluginScaffoldingRules = z.infer<
  typeof pluginScaffoldingRulesSchema
>;
export type PluginManifest = z.infer<typeof pluginManifestSchema>;
export type Origin = z.infer<typeof originSchema>;
// Template-side types use `z.input` so callers can construct a TemplatePlugin
// from a parsed PluginManifest before the field-level origin transform runs.
// `writeManifest` parses every field through `templateFieldEntrySchema` at
// write-time, so the on-disk shape always has origin populated. The runtime
// invariant: origin is *always* present after sync writes; the type slot
// stays optional so the in-memory pipeline does not need to fabricate origin
// before assignment.
export type TemplateFieldEntry = z.input<typeof templateFieldEntrySchema>;
export type TemplateResourceRequirement = z.input<
  typeof templateResourceRequirementSchema
>;
export type TemplatePlugin = z.input<typeof templatePluginSchema>;
export type ScaffoldingFlag = z.infer<typeof scaffoldingFlagSchema>;
export type ScaffoldingRules = z.infer<typeof scaffoldingRulesSchema>;
export type ScaffoldingDescriptor = z.infer<typeof scaffoldingDescriptorSchema>;
export type TemplatePluginsManifest = z.input<
  typeof templatePluginsManifestSchema
>;
