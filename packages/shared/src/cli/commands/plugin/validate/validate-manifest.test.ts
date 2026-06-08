import { describe, expect, it } from "vitest";
import {
  RESOURCE_KIND_COMMANDS,
  scaffoldingDescriptorSchema,
  TEMPLATE_SCAFFOLDING,
} from "../../../../schemas/manifest";
import {
  detectSchemaType,
  formatValidationErrors,
  type SemanticIssue,
  validateManifest,
  validateTemplateManifest,
} from "./validate-manifest";

const VALID_MANIFEST = {
  $schema:
    "https://databricks.github.io/appkit/schemas/plugin-manifest.schema.json",
  name: "test-plugin",
  displayName: "Test Plugin",
  description: "A test plugin",
  resources: {
    required: [],
    optional: [],
  },
};

const VALID_MANIFEST_WITH_RESOURCE = {
  ...VALID_MANIFEST,
  resources: {
    required: [
      {
        type: "sql_warehouse",
        alias: "SQL Warehouse",
        resourceKey: "sql-warehouse",
        description: "Required for queries",
        permission: "CAN_USE",
        fields: {
          id: {
            env: "DATABRICKS_WAREHOUSE_ID",
            description: "SQL Warehouse ID",
          },
        },
      },
    ],
    optional: [],
  },
};

describe("validate-manifest", () => {
  describe("detectSchemaType", () => {
    it('returns "plugin-manifest" for plugin manifest $schema', () => {
      expect(
        detectSchemaType({
          $schema:
            "https://databricks.github.io/appkit/schemas/plugin-manifest.schema.json",
        }),
      ).toBe("plugin-manifest");
    });

    it('returns "template-plugins" for template $schema', () => {
      expect(
        detectSchemaType({
          $schema:
            "https://databricks.github.io/appkit/schemas/template-plugins.schema.json",
        }),
      ).toBe("template-plugins");
    });

    it('returns "unknown" for missing $schema', () => {
      expect(detectSchemaType({})).toBe("unknown");
      expect(detectSchemaType({ name: "test" })).toBe("unknown");
    });

    it('returns "unknown" for unrecognized $schema', () => {
      expect(
        detectSchemaType({ $schema: "https://example.com/schema.json" }),
      ).toBe("unknown");
    });

    it('returns "unknown" for non-object inputs', () => {
      expect(detectSchemaType(null)).toBe("unknown");
      expect(detectSchemaType(undefined)).toBe("unknown");
      expect(detectSchemaType("string")).toBe("unknown");
      expect(detectSchemaType(42)).toBe("unknown");
    });
  });

  describe("validateManifest", () => {
    it("validates a minimal correct manifest", () => {
      const result = validateManifest(VALID_MANIFEST);
      expect(result.valid).toBe(true);
      expect(result.manifest).toBeDefined();
      expect(result.manifest?.name).toBe("test-plugin");
    });

    it("validates a manifest with resources", () => {
      const result = validateManifest(VALID_MANIFEST_WITH_RESOURCE);
      expect(result.valid).toBe(true);
      expect(result.manifest?.resources.required).toHaveLength(1);
    });

    it("rejects non-object input", () => {
      expect(validateManifest(null).valid).toBe(false);
      expect(validateManifest("string").valid).toBe(false);
      expect(validateManifest(42).valid).toBe(false);
    });

    it("rejects manifest with missing required fields", () => {
      const result = validateManifest({ name: "test" });
      expect(result.valid).toBe(false);
      expect(result.errors).toBeDefined();
      expect((result.errors ?? []).length).toBeGreaterThan(0);
    });

    it("rejects manifest with invalid name pattern", () => {
      const result = validateManifest({
        ...VALID_MANIFEST,
        name: "Invalid-Name",
      });
      expect(result.valid).toBe(false);
    });

    it("rejects manifest with invalid resource type", () => {
      const result = validateManifest({
        ...VALID_MANIFEST,
        resources: {
          required: [
            {
              type: "invalid_type",
              alias: "Invalid",
              resourceKey: "invalid",
              description: "test",
              permission: "CAN_VIEW",
              fields: { id: { env: "TEST_ID" } },
            },
          ],
          optional: [],
        },
      });
      expect(result.valid).toBe(false);
    });

    it("rejects manifest with invalid permission for resource type", () => {
      const result = validateManifest({
        ...VALID_MANIFEST,
        resources: {
          required: [
            {
              type: "sql_warehouse",
              alias: "SQL Warehouse",
              resourceKey: "sql-warehouse",
              description: "Required for queries",
              permission: "INVALID_PERM",
              fields: {
                id: { env: "DATABRICKS_WAREHOUSE_ID" },
              },
            },
          ],
          optional: [],
        },
      });
      expect(result.valid).toBe(false);
    });

    it("validates correct type-specific permissions", () => {
      const testCases = [
        { type: "secret", permission: "READ" },
        { type: "job", permission: "CAN_VIEW" },
        { type: "sql_warehouse", permission: "CAN_USE" },
        { type: "serving_endpoint", permission: "CAN_QUERY" },
        { type: "volume", permission: "READ_VOLUME" },
        { type: "vector_search_index", permission: "SELECT" },
        { type: "uc_function", permission: "EXECUTE" },
        { type: "uc_connection", permission: "USE_CONNECTION" },
        { type: "database", permission: "CAN_CONNECT_AND_CREATE" },
        { type: "genie_space", permission: "CAN_VIEW" },
        { type: "experiment", permission: "CAN_READ" },
        { type: "app", permission: "CAN_USE" },
      ];

      for (const { type, permission } of testCases) {
        const manifest = {
          ...VALID_MANIFEST,
          resources: {
            required: [
              {
                type,
                alias: "Test",
                resourceKey: type.replace(/_/g, "-"),
                description: "test",
                permission,
                fields: { id: { env: "TEST_ID" } },
              },
            ],
            optional: [],
          },
        };
        const result = validateManifest(manifest);
        expect(result.valid).toBe(true);
      }
    });

    it("rejects cross-type permissions (e.g. secret permission on sql_warehouse)", () => {
      const result = validateManifest({
        ...VALID_MANIFEST,
        resources: {
          required: [
            {
              type: "sql_warehouse",
              alias: "SQL Warehouse",
              resourceKey: "sql-warehouse",
              description: "test",
              permission: "READ",
              fields: { id: { env: "WAREHOUSE_ID" } },
            },
          ],
          optional: [],
        },
      });
      expect(result.valid).toBe(false);
    });
  });

  describe("validateTemplateManifest", () => {
    it("validates a minimal correct template manifest", () => {
      const result = validateTemplateManifest({
        $schema:
          "https://databricks.github.io/appkit/schemas/template-plugins.schema.json",
        version: "1.0",
        plugins: {},
      });
      expect(result.valid).toBe(true);
    });

    it("rejects non-object input", () => {
      expect(validateTemplateManifest(null).valid).toBe(false);
      expect(validateTemplateManifest("string").valid).toBe(false);
    });
  });

  describe("formatValidationErrors", () => {
    it("formats a single issue with humanized path", () => {
      const issues: SemanticIssue[] = [
        {
          level: "error",
          path: "name",
          message: "Invalid string: must match pattern",
        },
      ];
      const output = formatValidationErrors(issues);
      expect(output).toBe("  name: Invalid string: must match pattern");
    });

    it("formats nested array paths with bracket notation", () => {
      const issues: SemanticIssue[] = [
        {
          level: "error",
          path: "resources.required[0].permission",
          message: "Invalid option",
        },
      ];
      const output = formatValidationErrors(issues);
      expect(output).toContain("resources.required[0].permission");
      expect(output).toContain("Invalid option");
    });

    it("emits one line per issue", () => {
      const issues: SemanticIssue[] = [
        {
          level: "error",
          path: "name",
          message: "missing",
        },
        {
          level: "error",
          path: "displayName",
          message: "must not be empty",
        },
      ];
      const output = formatValidationErrors(issues);
      const lines = output.split("\n");
      expect(lines).toHaveLength(2);
    });

    it("handles empty issue list", () => {
      expect(formatValidationErrors([])).toBe("");
    });
  });

  describe("validation error contents (semantic equivalence)", () => {
    it("reports missing required property", () => {
      const result = validateManifest({ name: "test" });
      expect(result.valid).toBe(false);
      const formatted = formatValidationErrors(result.errors ?? []);
      // Zod reports missing required props as "Invalid input: expected ..."
      expect(formatted).toMatch(/displayName|description|resources/);
    });

    it("reports invalid name pattern with the path", () => {
      const result = validateManifest({
        ...VALID_MANIFEST,
        name: "INVALID",
      });
      expect(result.valid).toBe(false);
      const formatted = formatValidationErrors(result.errors ?? []);
      expect(formatted).toContain("name");
      expect(formatted).toMatch(/pattern/i);
    });

    it("reports invalid permission for type with allowed enum hints", () => {
      const result = validateManifest({
        ...VALID_MANIFEST,
        resources: {
          required: [
            {
              type: "sql_warehouse",
              alias: "Warehouse",
              resourceKey: "wh",
              description: "wh",
              permission: "INVALID_PERM",
              fields: { id: { env: "TEST_ID" } },
            },
          ],
          optional: [],
        },
      });
      expect(result.valid).toBe(false);
      const formatted = formatValidationErrors(result.errors ?? []);
      expect(formatted).toContain("resources.required[0].permission");
      expect(formatted).toMatch(/CAN_USE/);
    });

    it("reports unknown property at root", () => {
      const result = validateManifest({
        ...VALID_MANIFEST,
        nonsenseField: "boom",
      });
      expect(result.valid).toBe(false);
      const formatted = formatValidationErrors(result.errors ?? []);
      expect(formatted).toMatch(/nonsenseField|Unrecognized/);
    });

    it("reports type mismatch", () => {
      const result = validateManifest({
        ...VALID_MANIFEST,
        name: 42,
      });
      expect(result.valid).toBe(false);
      const formatted = formatValidationErrors(result.errors ?? []);
      expect(formatted).toContain("name");
      expect(formatted).toMatch(/expected string|received number/);
    });

    it("reports empty-string failures from min(1)", () => {
      const result = validateManifest({
        ...VALID_MANIFEST,
        displayName: "",
      });
      expect(result.valid).toBe(false);
      const formatted = formatValidationErrors(result.errors ?? []);
      expect(formatted).toContain("displayName");
    });
  });

  describe("semantic refinements (cycles, dangling refs, <PROFILE>)", () => {
    it("returns valid for a manifest without discovery", () => {
      const result = validateManifest(VALID_MANIFEST_WITH_RESOURCE);
      expect(result.valid).toBe(true);
    });

    it("detects dangling dependsOn reference", () => {
      const manifest = {
        ...VALID_MANIFEST,
        resources: {
          required: [
            {
              type: "postgres",
              alias: "Postgres",
              resourceKey: "postgres",
              description: "test",
              permission: "CAN_CONNECT_AND_CREATE",
              fields: {
                branch: {
                  env: "BRANCH",
                  description: "Branch name",
                  discovery: {
                    type: "cli",
                    cliCommand:
                      "databricks postgres list-branches --profile <PROFILE>",
                    selectField: ".name",
                    dependsOn: "nonexistent",
                  },
                },
              },
            },
          ],
          optional: [],
        },
      };
      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
      const messages = (result.errors ?? []).map((e) => e.message).join("\n");
      expect(messages).toContain("non-existent sibling field");
      expect(messages).toContain("nonexistent");
    });

    it("detects cyclic dependsOn chain", () => {
      const manifest = {
        ...VALID_MANIFEST,
        resources: {
          required: [
            {
              type: "postgres",
              alias: "Postgres",
              resourceKey: "postgres",
              description: "test",
              permission: "CAN_CONNECT_AND_CREATE",
              fields: {
                a: {
                  env: "A",
                  discovery: {
                    type: "cli",
                    cliCommand: "databricks cmd --profile <PROFILE>",
                    selectField: ".id",
                    dependsOn: "b",
                  },
                },
                b: {
                  env: "B",
                  discovery: {
                    type: "cli",
                    cliCommand: "databricks cmd --profile <PROFILE>",
                    selectField: ".id",
                    dependsOn: "a",
                  },
                },
              },
            },
          ],
          optional: [],
        },
      };
      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
      const cycleErrors = (result.errors ?? []).filter((e) =>
        e.message.includes("cycle"),
      );
      expect(cycleErrors.length).toBeGreaterThan(0);
      // Cycle path targets the resource, not a specific field.
      expect(cycleErrors[0].path).toContain("resources.required[0]");
    });

    it("detects cyclic dependsOn chain across kind variants", () => {
      const manifest = {
        ...VALID_MANIFEST,
        resources: {
          required: [
            {
              type: "postgres",
              alias: "Postgres",
              resourceKey: "postgres",
              description: "test",
              permission: "CAN_CONNECT_AND_CREATE",
              fields: {
                branch: {
                  env: "BRANCH",
                  discovery: {
                    type: "kind",
                    resourceKind: "postgres_branch",
                    dependsOn: "database",
                  },
                },
                database: {
                  env: "DATABASE",
                  discovery: {
                    type: "kind",
                    resourceKind: "postgres_database",
                    dependsOn: "branch",
                  },
                },
              },
            },
          ],
          optional: [],
        },
      };
      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
      const cycleErrors = (result.errors ?? []).filter((e) =>
        e.message.includes("cycle"),
      );
      expect(cycleErrors.length).toBeGreaterThan(0);
    });

    it("detects missing <PROFILE> in cli variant cliCommand", () => {
      const manifest = {
        ...VALID_MANIFEST,
        resources: {
          required: [
            {
              type: "sql_warehouse",
              alias: "SQL Warehouse",
              resourceKey: "sql-warehouse",
              description: "test",
              permission: "CAN_USE",
              fields: {
                id: {
                  env: "WAREHOUSE_ID",
                  discovery: {
                    type: "cli",
                    cliCommand: "databricks warehouses list --output json",
                    selectField: ".id",
                  },
                },
              },
            },
          ],
          optional: [],
        },
      };
      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
      const messages = (result.errors ?? []).map((e) => e.message).join("\n");
      expect(messages).toContain("<PROFILE>");
    });

    it("rejects manifests that still carry the legacy postScaffold array", () => {
      // `postScaffold` is no longer part of the plugin manifest schema; the
      // strict object rejects it as an unknown property.
      const manifest = {
        ...VALID_MANIFEST,
        postScaffold: [{ instruction: "Legacy step" }],
      };
      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
      const formatted = formatValidationErrors(result.errors ?? []);
      expect(formatted).toMatch(/postScaffold|Unrecognized/);
    });

    it("passes for valid manifest with all new fields", () => {
      const manifest = {
        ...VALID_MANIFEST,
        scaffolding: {
          rules: {
            must: ["Run migrations after init"],
            should: ["Verify connectivity before first request"],
          },
        },
        resources: {
          required: [
            {
              type: "sql_warehouse",
              alias: "SQL Warehouse",
              resourceKey: "sql-warehouse",
              description: "test",
              permission: "CAN_USE",
              fields: {
                id: {
                  env: "WAREHOUSE_ID",
                  description: "Warehouse ID",
                  discovery: {
                    type: "cli",
                    cliCommand:
                      "databricks warehouses list --profile <PROFILE> --output json",
                    selectField: ".id",
                    displayField: ".name",
                  },
                },
              },
            },
          ],
          optional: [],
        },
      };
      const result = validateManifest(manifest);
      expect(result.valid).toBe(true);
    });
  });

  describe("plugin scaffolding.rules", () => {
    it("rejects a must[] entry exceeding 120 characters", () => {
      const tooLong = "x".repeat(121);
      const manifest = {
        ...VALID_MANIFEST,
        scaffolding: {
          rules: { must: [tooLong] },
        },
      };
      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
      const formatted = formatValidationErrors(result.errors ?? []);
      expect(formatted).toContain("scaffolding.rules.must[0]");
      expect(formatted).toMatch(/≤ 120 chars/);
    });

    it("accepts must[] entries at exactly 120 characters", () => {
      const atMax = "x".repeat(120);
      const manifest = {
        ...VALID_MANIFEST,
        scaffolding: {
          rules: { must: [atMax] },
        },
      };
      const result = validateManifest(manifest);
      expect(result.valid).toBe(true);
    });

    it("rejects duplicate entries within the same rules bucket", () => {
      const manifest = {
        ...VALID_MANIFEST,
        scaffolding: {
          rules: {
            must: ["Run migrations after init", "Run migrations after init"],
          },
        },
      };
      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
      const formatted = formatValidationErrors(result.errors ?? []);
      expect(formatted).toMatch(/duplicate rule entry/);
      expect(formatted).toContain("scaffolding.rules.must[1]");
    });

    it("rejects a string appearing in more than one rules bucket", () => {
      const shared = "Run migrations after init";
      const manifest = {
        ...VALID_MANIFEST,
        scaffolding: {
          rules: {
            must: [shared],
            never: [shared],
          },
        },
      };
      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
      const formatted = formatValidationErrors(result.errors ?? []);
      expect(formatted).toMatch(/exactly one bucket/);
      expect(formatted).toMatch(/scaffolding\.rules\.(must|never|should)\[0\]/);
    });

    it("accepts an empty scaffolding.rules block", () => {
      const manifest = {
        ...VALID_MANIFEST,
        scaffolding: { rules: {} },
      };
      const result = validateManifest(manifest);
      expect(result.valid).toBe(true);
    });

    it("accepts a scaffolding object without rules", () => {
      const manifest = {
        ...VALID_MANIFEST,
        scaffolding: {},
      };
      const result = validateManifest(manifest);
      expect(result.valid).toBe(true);
    });
  });

  describe("discovery descriptor (discriminated union)", () => {
    function buildManifestWithDiscovery(
      type: string,
      permission: string,
      discovery: unknown,
    ): unknown {
      return {
        ...VALID_MANIFEST,
        resources: {
          required: [
            {
              type,
              alias: "Test Resource",
              resourceKey: "test",
              description: "test",
              permission,
              fields: {
                id: {
                  env: "TEST_ID",
                  discovery,
                },
              },
            },
          ],
          optional: [],
        },
      };
    }

    it("accepts a manifest with no discovery descriptor (v1.0 fixture)", () => {
      // No `discovery` field on the resource field — minimal v1.0-shaped manifest.
      const result = validateManifest({
        ...VALID_MANIFEST,
        resources: {
          required: [
            {
              type: "sql_warehouse",
              alias: "SQL Warehouse",
              resourceKey: "sql-warehouse",
              description: "Required for queries",
              permission: "CAN_USE",
              fields: {
                id: {
                  env: "DATABRICKS_WAREHOUSE_ID",
                  description: "SQL Warehouse ID",
                },
              },
            },
          ],
          optional: [],
        },
      });
      expect(result.valid).toBe(true);
    });

    it("accepts kind variant for warehouse", () => {
      const result = validateManifest(
        buildManifestWithDiscovery("sql_warehouse", "CAN_USE", {
          type: "kind",
          resourceKind: "warehouse",
        }),
      );
      expect(result.valid).toBe(true);
    });

    it("accepts kind variant for genie_space", () => {
      const result = validateManifest(
        buildManifestWithDiscovery("genie_space", "CAN_RUN", {
          type: "kind",
          resourceKind: "genie_space",
        }),
      );
      expect(result.valid).toBe(true);
    });

    it("accepts kind variant for postgres_branch", () => {
      const result = validateManifest(
        buildManifestWithDiscovery("postgres", "CAN_CONNECT_AND_CREATE", {
          type: "kind",
          resourceKind: "postgres_branch",
        }),
      );
      expect(result.valid).toBe(true);
    });

    it("accepts kind variant for postgres_database with dependsOn", () => {
      const manifest = {
        ...VALID_MANIFEST,
        resources: {
          required: [
            {
              type: "postgres",
              alias: "Postgres",
              resourceKey: "postgres",
              description: "test",
              permission: "CAN_CONNECT_AND_CREATE",
              fields: {
                branch: {
                  env: "BRANCH",
                  discovery: {
                    type: "kind",
                    resourceKind: "postgres_branch",
                  },
                },
                database: {
                  env: "DATABASE",
                  discovery: {
                    type: "kind",
                    resourceKind: "postgres_database",
                    dependsOn: "branch",
                  },
                },
              },
            },
          ],
          optional: [],
        },
      };
      const result = validateManifest(manifest);
      expect(result.valid).toBe(true);
    });

    it("accepts kind variant for volume with custom select", () => {
      const result = validateManifest(
        buildManifestWithDiscovery("volume", "READ_VOLUME", {
          type: "kind",
          resourceKind: "volume",
          select: "full_name",
        }),
      );
      expect(result.valid).toBe(true);
    });

    it("rejects kind variant with unrecognized resourceKind", () => {
      const result = validateManifest(
        buildManifestWithDiscovery("sql_warehouse", "CAN_USE", {
          type: "kind",
          resourceKind: "unknown_kind",
        }),
      );
      expect(result.valid).toBe(false);
      const formatted = formatValidationErrors(result.errors ?? []);
      expect(formatted).toContain("resourceKind");
    });

    it("accepts cli variant with <PROFILE>", () => {
      const result = validateManifest(
        buildManifestWithDiscovery("sql_warehouse", "CAN_USE", {
          type: "cli",
          cliCommand:
            "databricks warehouses list --profile <PROFILE> --output json",
          selectField: ".id",
          displayField: ".name",
        }),
      );
      expect(result.valid).toBe(true);
    });

    it("rejects cli variant missing cliCommand", () => {
      const result = validateManifest(
        buildManifestWithDiscovery("sql_warehouse", "CAN_USE", {
          type: "cli",
          selectField: ".id",
        }),
      );
      expect(result.valid).toBe(false);
      const formatted = formatValidationErrors(result.errors ?? []);
      expect(formatted).toContain("cliCommand");
    });

    it("rejects cli variant missing selectField", () => {
      const result = validateManifest(
        buildManifestWithDiscovery("sql_warehouse", "CAN_USE", {
          type: "cli",
          cliCommand:
            "databricks warehouses list --profile <PROFILE> --output json",
        }),
      );
      expect(result.valid).toBe(false);
      const formatted = formatValidationErrors(result.errors ?? []);
      expect(formatted).toContain("selectField");
    });

    it("rejects discovery descriptor missing type discriminator", () => {
      const result = validateManifest(
        buildManifestWithDiscovery("sql_warehouse", "CAN_USE", {
          cliCommand:
            "databricks warehouses list --profile <PROFILE> --output json",
          selectField: ".id",
        }),
      );
      expect(result.valid).toBe(false);
      const formatted = formatValidationErrors(result.errors ?? []);
      // Either a missing-discriminator error, or a "type" path issue.
      expect(formatted).toMatch(/type|discriminator/i);
    });

    it("rejects cli variant with shell metacharacters in cliCommand", () => {
      const result = validateManifest(
        buildManifestWithDiscovery("sql_warehouse", "CAN_USE", {
          type: "cli",
          cliCommand:
            "databricks warehouses list --profile <PROFILE> --output json; rm -rf /",
          selectField: ".id",
        }),
      );
      expect(result.valid).toBe(false);
      const formatted = formatValidationErrors(result.errors ?? []);
      expect(formatted).toContain("cliCommand");
      expect(formatted).toMatch(/shell metacharacters/i);
    });

    it("rejects cli variant with shell metacharacters in shortcut", () => {
      const result = validateManifest(
        buildManifestWithDiscovery("sql_warehouse", "CAN_USE", {
          type: "cli",
          cliCommand:
            "databricks warehouses list --profile <PROFILE> --output json",
          selectField: ".id",
          shortcut:
            "databricks warehouses get <ID> --profile <PROFILE> | tail -n1",
        }),
      );
      expect(result.valid).toBe(false);
      const formatted = formatValidationErrors(result.errors ?? []);
      expect(formatted).toContain("shortcut");
      expect(formatted).toMatch(/shell metacharacters/i);
    });
  });

  describe("scaffolding rule item maxLength", () => {
    function buildTemplateManifestWithRules(rules: {
      never?: string[];
      must?: string[];
    }): unknown {
      return {
        $schema:
          "https://databricks.github.io/appkit/schemas/template-plugins.schema.json",
        version: "2.0",
        plugins: {},
        scaffolding: {
          command: "databricks apps init",
          rules,
        },
      };
    }

    // 121-char string — one past the boundary.
    const TOO_LONG = "x".repeat(121);
    // 120-char string — at the boundary.
    const AT_MAX = "x".repeat(120);

    it("rejects a never[] item exceeding 120 characters", () => {
      const result = validateTemplateManifest(
        buildTemplateManifestWithRules({ never: [TOO_LONG] }),
      );
      expect(result.valid).toBe(false);
      const formatted = formatValidationErrors(result.errors ?? []);
      expect(formatted).toContain("scaffolding.rules.never[0]");
      expect(formatted).toMatch(/120/);
    });

    it("rejects a must[] item exceeding 120 characters", () => {
      const result = validateTemplateManifest(
        buildTemplateManifestWithRules({ must: [TOO_LONG] }),
      );
      expect(result.valid).toBe(false);
      const formatted = formatValidationErrors(result.errors ?? []);
      expect(formatted).toContain("scaffolding.rules.must[0]");
      expect(formatted).toMatch(/120/);
    });

    it("accepts rule items at exactly 120 characters", () => {
      const result = validateTemplateManifest(
        buildTemplateManifestWithRules({
          never: [AT_MAX],
          must: [AT_MAX],
        }),
      );
      expect(result.valid).toBe(true);
    });

    it("flags only the offending entry in a mixed-length array", () => {
      const result = validateTemplateManifest(
        buildTemplateManifestWithRules({
          must: ["short directive", TOO_LONG, "another short one"],
        }),
      );
      expect(result.valid).toBe(false);
      const paths = (result.errors ?? []).map((e) => e.path);
      expect(paths).toContain("scaffolding.rules.must[1]");
      expect(paths).not.toContain("scaffolding.rules.must[0]");
      expect(paths).not.toContain("scaffolding.rules.must[2]");
    });

    it("TEMPLATE_SCAFFOLDING parses against scaffoldingDescriptorSchema", () => {
      // The exported constant must validate against its own schema, including
      // the maxLength ceiling on each rule item.
      const parsed = scaffoldingDescriptorSchema.parse(TEMPLATE_SCAFFOLDING);
      expect(parsed.command).toBe("databricks apps init");
      expect(parsed.rules?.must).toBeDefined();
      expect(parsed.rules?.never).toBeDefined();
      expect(parsed.rules?.should).toBeDefined();
    });

    it("TEMPLATE_SCAFFOLDING.rules contains the expected directives", () => {
      // Pins the canonical content of TEMPLATE_SCAFFOLDING.rules so changes
      // to the must/should/never strings are explicit and reviewed.
      expect(TEMPLATE_SCAFFOLDING.rules.must).toEqual([
        "Keep all secrets and credentials only in app.yaml, databricks.yml, and/or .env",
      ]);
      expect(TEMPLATE_SCAFFOLDING.rules.should).toEqual([
        "ask user when in doubt of resource to use for plugin",
      ]);
      expect(TEMPLATE_SCAFFOLDING.rules.never).toEqual([
        "guess resources when multiple or no options are available",
        "embed secrets in files that will go to the client-bundle",
      ]);
    });
  });

  describe("RESOURCE_KIND_COMMANDS", () => {
    // Volume's catalog+schema prerequisite chain is modeled structurally via
    // a `parents` array on the kind table. These tests pin that shape.

    it("volume kind declares parents = [catalog, schema]", () => {
      expect(RESOURCE_KIND_COMMANDS.volume.parents).toEqual([
        "catalog",
        "schema",
      ]);
    });

    it("volume command string carries matching {catalog} and {schema} placeholders", () => {
      expect(RESOURCE_KIND_COMMANDS.volume.command).toContain("{catalog}");
      expect(RESOURCE_KIND_COMMANDS.volume.command).toContain("{schema}");
    });

    it("volume is the only kind declaring parents (others use dependsOn siblings)", () => {
      const withParents = Object.entries(RESOURCE_KIND_COMMANDS).filter(
        ([, v]) => v.parents,
      );
      expect(withParents).toHaveLength(1);
      expect(withParents[0]?.[0]).toBe("volume");
    });
  });
});
