/**
 * Parity gate for the Zod-authored manifest schema.
 *
 * Strategy: fixture equivalence (Strategy B).
 *
 * Rationale: byte-equivalence (Strategy A) is not achievable. Zod 4's
 * `toJSONSchema` represents per-`type` permission constraints via
 * `oneOf` over discriminated-union variants, while the hand-written JSON
 * Schema uses an `allOf + if/then` block over a base resourceRequirement
 * definition with a `$defs`-resolved permission. Both shapes are valid
 * JSON Schema draft-07, and AJV accepts both, but they are not byte
 * identical and cannot be made so without substantial post-processing
 * that would not survive future schema changes.
 *
 * Documented diffs observed between the legacy hand-written JSON Schema
 * and the Zod-generated output:
 *
 * - The legacy schema uses `$defs/resourceRequirement` + `allOf+if/then`
 *   to constrain `permission` per `type`. The Zod output inlines a
 *   `oneOf` of variants discriminated on `type`.
 * - Legacy `examples` arrays at the property level are not emitted by
 *   Zod's `toJSONSchema`. Examples in `.describe()` text are preserved.
 * - Legacy schemas use `$defs` cross-references (`$ref` to shared
 *   permission enums); Zod inlines `enum` arrays at each call site.
 * - Legacy `fields` uses `minProperties: 1`; Zod `refine` cannot be
 *   represented in JSON Schema, so this constraint exists only at
 *   parse time.
 * - Legacy `version` enum on the template uses array order
 *   ["1.0", "1.1", "2.0"]; Zod preserves source order.
 *
 * The test below asserts that for every fixture, the AJV-with-legacy-schema
 * verdict matches the Zod-with-new-schema verdict. That is the contract
 * the parity gate guards: equivalent acceptance/rejection on real and
 * synthetic manifests, not byte identity of the schema files.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  pluginManifestSchema,
  templatePluginsManifestSchema,
} from "../manifest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../../..");
const PLUGIN_SCHEMA_PATH = path.join(
  REPO_ROOT,
  "packages/shared/src/schemas/plugin-manifest.schema.json",
);
const TEMPLATE_SCHEMA_PATH = path.join(
  REPO_ROOT,
  "packages/shared/src/schemas/template-plugins.schema.json",
);

const PLUGINS_DIR = path.join(REPO_ROOT, "packages/appkit/src/plugins");

function loadJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function buildAjvForPlugin() {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv.compile(loadJson(PLUGIN_SCHEMA_PATH) as object);
}

function buildAjvForTemplate() {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(loadJson(PLUGIN_SCHEMA_PATH) as object);
  return ajv.compile(loadJson(TEMPLATE_SCHEMA_PATH) as object);
}

const validateLegacyPlugin = buildAjvForPlugin();
const validateLegacyTemplate = buildAjvForTemplate();

interface PluginFixture {
  label: string;
  manifest: unknown;
}

const corePluginFixtures: PluginFixture[] = [
  "analytics",
  "files",
  "genie",
  "lakebase",
].map((name) => ({
  label: `core/${name}`,
  manifest: loadJson(path.join(PLUGINS_DIR, name, "manifest.json")),
}));

const minimalValid: PluginFixture = {
  label: "synthetic/minimal-valid",
  manifest: {
    $schema:
      "https://databricks.github.io/appkit/schemas/plugin-manifest.schema.json",
    name: "test-plugin",
    displayName: "Test Plugin",
    description: "A test plugin",
    resources: {
      required: [],
      optional: [],
    },
  },
};

const invalidUnknownProperty: PluginFixture = {
  label: "synthetic/invalid-unknown-property",
  manifest: {
    ...(minimalValid.manifest as object),
    nonsenseField: "boom",
  },
};

const invalidPermissionForType: PluginFixture = {
  label: "synthetic/invalid-permission-for-type",
  manifest: {
    name: "bad",
    displayName: "Bad",
    description: "Wrong permission for sql_warehouse",
    resources: {
      required: [
        {
          type: "sql_warehouse",
          alias: "Warehouse",
          resourceKey: "wh",
          description: "wh",
          // Wrong: this enum is for `genie_space`
          permission: "CAN_RUN",
        },
      ],
      optional: [],
    },
  },
};

const invalidNamePattern: PluginFixture = {
  label: "synthetic/invalid-name-pattern",
  manifest: {
    name: "Invalid_Name",
    displayName: "Bad",
    description: "Bad name pattern",
    resources: { required: [], optional: [] },
  },
};

const missingRequired: PluginFixture = {
  label: "synthetic/missing-required",
  manifest: {
    displayName: "Missing name",
    description: "...",
    resources: { required: [], optional: [] },
  },
};

const pluginFixtures: PluginFixture[] = [
  ...corePluginFixtures,
  minimalValid,
  invalidUnknownProperty,
  invalidPermissionForType,
  invalidNamePattern,
  missingRequired,
];

interface TemplateFixture {
  label: string;
  manifest: unknown;
}

const minimalTemplateValid: TemplateFixture = {
  label: "synthetic/template-minimal-valid",
  manifest: {
    version: "1.1",
    plugins: {
      example: {
        name: "example",
        displayName: "Example",
        description: "An example plugin",
        package: "@databricks/appkit",
        resources: { required: [], optional: [] },
      },
    },
  },
};

const templateMissingScaffolding: TemplateFixture = {
  label: "synthetic/template-2.0-missing-scaffolding",
  manifest: {
    version: "2.0",
    plugins: {},
  },
};

const templateInvalidVersion: TemplateFixture = {
  label: "synthetic/template-bad-version",
  manifest: {
    version: "9.9",
    plugins: {},
  },
};

const templateFixtures: TemplateFixture[] = [
  minimalTemplateValid,
  templateMissingScaffolding,
  templateInvalidVersion,
];

describe("plugin manifest schema parity (Strategy B: fixture equivalence)", () => {
  for (const fixture of pluginFixtures) {
    it(`agrees on ${fixture.label}`, () => {
      const legacyValid = validateLegacyPlugin(fixture.manifest);
      const zodResult = pluginManifestSchema.safeParse(fixture.manifest);
      expect(
        zodResult.success,
        legacyValid
          ? "legacy schema accepted but Zod schema rejected"
          : "legacy schema rejected but Zod schema accepted",
      ).toBe(legacyValid);
    });
  }
});

describe("template manifest schema parity (Strategy B: fixture equivalence)", () => {
  for (const fixture of templateFixtures) {
    it(`agrees on ${fixture.label}`, () => {
      const legacyValid = validateLegacyTemplate(fixture.manifest);
      const zodResult = templatePluginsManifestSchema.safeParse(
        fixture.manifest,
      );
      expect(
        zodResult.success,
        legacyValid
          ? "legacy template schema accepted but Zod template schema rejected"
          : "legacy template schema rejected but Zod template schema accepted",
      ).toBe(legacyValid);
    });
  }
});
