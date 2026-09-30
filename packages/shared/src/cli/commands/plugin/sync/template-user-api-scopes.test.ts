import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const template = fs.readFileSync(
  path.resolve(__dirname, "../../../../../../../template/databricks.yml.tmpl"),
  "utf-8",
);

// Old CLIs never set .bundle.userApiScopes, so this branch must stay byte-for-byte.
const LEGACY_BLOCK = `{{- else if or .plugins.genie .plugins.files .plugins.serving}}
      user_api_scopes:
{{- if .plugins.genie}}
        - dashboards.genie
{{- end}}
{{- if .plugins.files}}
        - files.files
{{- end}}
{{- if .plugins.serving}}
        - serving.serving-endpoints
{{- end}}
{{- else}}
      # Uncomment to enable on behalf of user API scopes. Available scopes: sql, dashboards.genie, files.files, serving.serving-endpoints
      # user_api_scopes:
      #   - sql
{{- end}}`;

describe("template databricks.yml user_api_scopes", () => {
  it("renders generator-provided scopes when set", () => {
    expect(template).toContain(
      "{{- if .bundle.userApiScopes}}\n      user_api_scopes:\n{{.bundle.userApiScopes}}\n",
    );
  });

  it("falls back to the unchanged plugin-presence block", () => {
    expect(template).toContain(`{{.bundle.userApiScopes}}\n${LEGACY_BLOCK}`);
  });
});
