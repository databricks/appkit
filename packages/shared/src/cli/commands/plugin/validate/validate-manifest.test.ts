import type { ErrorObject } from "ajv";
import { describe, expect, it } from "vitest";
import {
  detectSchemaType,
  formatValidationErrors,
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
    it("formats a required-property error", () => {
      const errors: ErrorObject[] = [
        {
          keyword: "required",
          instancePath: "",
          schemaPath: "#/required",
          params: { missingProperty: "name" },
          message: "must have required property 'name'",
        },
      ];
      const output = formatValidationErrors(errors);
      expect(output).toContain('missing required property "name"');
    });

    it("formats an enum error with actual value", () => {
      const errors: ErrorObject[] = [
        {
          keyword: "enum",
          instancePath: "/resources/required/0/permission",
          schemaPath: "#/$defs/secretPermission/enum",
          params: { allowedValues: ["MANAGE", "READ", "WRITE"] },
          message: "must be equal to one of the allowed values",
        },
      ];
      const obj = {
        resources: {
          required: [{ permission: "INVALID" }],
        },
      };
      const output = formatValidationErrors(errors, obj);
      expect(output).toContain("resources.required[0].permission");
      expect(output).toContain('(got "INVALID")');
      expect(output).toContain("MANAGE, READ, WRITE");
    });

    it("formats a pattern error with actual value", () => {
      const errors: ErrorObject[] = [
        {
          keyword: "pattern",
          instancePath: "/name",
          schemaPath: "#/properties/name/pattern",
          params: { pattern: "^[a-z][a-z0-9-]*$" },
          message: 'must match pattern "^[a-z][a-z0-9-]*$"',
        },
      ];
      const obj = { name: "INVALID" };
      const output = formatValidationErrors(errors, obj);
      expect(output).toContain("name");
      expect(output).toContain("does not match expected pattern");
      expect(output).toContain('(got "INVALID")');
    });

    it("formats a type error", () => {
      const errors: ErrorObject[] = [
        {
          keyword: "type",
          instancePath: "/name",
          schemaPath: "#/properties/name/type",
          params: { type: "string" },
          message: "must be string",
        },
      ];
      const output = formatValidationErrors(errors);
      expect(output).toContain('expected type "string"');
    });

    it("formats a minLength error", () => {
      const errors: ErrorObject[] = [
        {
          keyword: "minLength",
          instancePath: "/displayName",
          schemaPath: "#/properties/displayName/minLength",
          params: { limit: 1 },
          message: "must NOT have fewer than 1 characters",
        },
      ];
      const output = formatValidationErrors(errors);
      expect(output).toContain("must not be empty");
    });

    it("formats an additionalProperties error", () => {
      const errors: ErrorObject[] = [
        {
          keyword: "additionalProperties",
          instancePath: "",
          schemaPath: "#/additionalProperties",
          params: { additionalProperty: "foo" },
          message: "must NOT have additional properties",
        },
      ];
      const output = formatValidationErrors(errors);
      expect(output).toContain('unknown property "foo"');
    });

    it("collapses anyOf with enum sub-errors", () => {
      const errors: ErrorObject[] = [
        {
          keyword: "enum",
          instancePath: "/perm",
          schemaPath: "#/$defs/a/enum",
          params: { allowedValues: ["A", "B"] },
          message: "must be equal to one of the allowed values",
        },
        {
          keyword: "enum",
          instancePath: "/perm",
          schemaPath: "#/$defs/b/enum",
          params: { allowedValues: ["C", "D"] },
          message: "must be equal to one of the allowed values",
        },
        {
          keyword: "anyOf",
          instancePath: "/perm",
          schemaPath: "#/anyOf",
          params: {},
          message: "must match a schema in anyOf",
        },
      ];
      const obj = { perm: "X" };
      const output = formatValidationErrors(errors, obj);
      expect(output).toContain('invalid value (got "X")');
      expect(output).toContain("A, B, C, D");
      const lines = output.split("\n");
      expect(lines.length).toBe(2);
    });

    it("skips if-keyword errors", () => {
      const errors: ErrorObject[] = [
        {
          keyword: "if",
          instancePath: "",
          schemaPath: "#/allOf/0/if",
          params: { failingKeyword: "if" },
          message: 'must match "if" schema',
        },
      ];
      const output = formatValidationErrors(errors);
      expect(output).toBe("");
    });

    it("handles root-level errors with empty instancePath", () => {
      const errors: ErrorObject[] = [
        {
          keyword: "required",
          instancePath: "",
          schemaPath: "#/required",
          params: { missingProperty: "name" },
          message: "must have required property 'name'",
        },
      ];
      const output = formatValidationErrors(errors);
      expect(output).toContain('missing required property "name"');
    });
  });
});
