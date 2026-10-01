import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { scanForPlugins, scanPluginsDir } from "./sync";

const probe = {
  name: "probe",
  displayName: "Probe",
  description: "Execution capability probe",
  scopes: ["ai-gateway"],
  resources: {
    required: [
      {
        type: "sql_warehouse",
        alias: "Warehouse",
        resourceKey: "sql-warehouse",
        description: "OBO-capable resource",
        permission: "CAN_USE",
        fields: { id: { env: "DATABRICKS_WAREHOUSE_ID" } },
      },
    ],
    optional: [
      {
        type: "secret",
        alias: "Secret",
        resourceKey: "secret",
        description: "App-only resource",
        permission: "READ",
        fields: { scope: { env: "SECRET_SCOPE" }, key: { env: "SECRET_KEY" } },
      },
      {
        type: "job",
        alias: "Job",
        resourceKey: "job",
        description: "SP-only resource with no scope",
        permission: "CAN_MANAGE_RUN",
        fields: { id: { env: "DATABRICKS_JOB_ID" } },
      },
    ],
  },
};

const plain = { ...probe, name: "plain", scopes: undefined };

function writeManifest(dir: string, manifest: object) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
}

describe("sync execution capabilities", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "appkit-sync-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const paths = {
    "plugins dir (loadPluginEntry)": async () => {
      writeManifest(path.join(tmp, "plugins", "probe"), probe);
      writeManifest(path.join(tmp, "plugins", "plain"), plain);
      return scanPluginsDir(path.join(tmp, "plugins"), "@x/pkg", false);
    },
    "node_modules scan (scanForPlugins)": async () => {
      const pluginsDir = path.join(
        tmp,
        "node_modules",
        "@x/pkg",
        "dist",
        "plugins",
      );
      writeManifest(path.join(pluginsDir, "probe"), probe);
      writeManifest(path.join(pluginsDir, "plain"), plain);
      return scanForPlugins(tmp, ["@x/pkg"], false);
    },
  };

  it.each(Object.entries(paths))(
    "%s bakes scope, appOnly, and scopes",
    async (_, scan) => {
      const plugins = await scan();
      const [warehouse] = plugins.probe.resources.required;
      const [secret, job] = plugins.probe.resources.optional;

      expect(warehouse.scope).toBe("sql");
      expect(warehouse).not.toHaveProperty("appOnly");
      expect(secret.appOnly).toBe(true);
      expect(secret).not.toHaveProperty("scope");
      expect(job).not.toHaveProperty("scope");
      expect(job).not.toHaveProperty("appOnly");
      expect(plugins.probe.scopes).toEqual(["ai-gateway"]);
      expect(plugins.plain).not.toHaveProperty("scopes");

      // DABs binding is baked per resource from DABS_BINDING_BY_TYPE.
      expect(warehouse.binding).toEqual({
        yamlKey: "sql_warehouse",
        varFields: [["id", "id"]],
      });
      expect(secret.binding).toEqual({
        yamlKey: "secret",
        varFields: [
          ["scope", "scope"],
          ["key", "key"],
        ],
      });
      expect(job.binding).toEqual({
        yamlKey: "job",
        varFields: [["id", "id"]],
      });
    },
  );

  it("core plugins declare the scopes they always use on behalf of the user", async () => {
    const plugins = await scanPluginsDir(
      path.resolve(__dirname, "../../../../../../appkit/src/plugins"),
      "@databricks/appkit",
      false,
    );
    // genie and serving routes always run as the user, whatever the resource binding.
    expect(plugins.genie.scopes).toEqual(["genie"]);
    expect(plugins.serving.scopes).toEqual(["model-serving"]);
    // These only act as the user when a resource or config opts in, so they stay unscoped.
    for (const name of ["analytics", "files", "aiSearch", "agents"]) {
      expect(plugins[name]).not.toHaveProperty("scopes");
    }

    // DABs binding is baked from the real core manifests, including the
    // uc_securable static field for volumes.
    const genieSpace = plugins.genie.resources.required.find(
      (r: { type: string }) => r.type === "genie_space",
    );
    expect(genieSpace?.binding).toEqual({
      yamlKey: "genie_space",
      varFields: [
        ["name", "name"],
        ["id", "space_id"],
      ],
    });
    const volume = plugins.files.resources.required.find(
      (r: { type: string }) => r.type === "volume",
    );
    expect(volume?.binding).toEqual({
      yamlKey: "uc_securable",
      varFields: [["id", "securable_full_name"]],
      staticFields: [["securable_type", "VOLUME"]],
    });
  });
});
