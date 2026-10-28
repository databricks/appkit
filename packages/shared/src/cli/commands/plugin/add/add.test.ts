import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "vitest";

import { envConflicts, pluginConfig, toSource } from "./add";
import type { ManifestPlugin, ManifestResource } from "./plan";

const index: ManifestResource = {
  type: "vector_search_index",
  alias: "Index",
  resourceKey: "vector-search-index",
  scope: "vector-search",
};
const plugin = (name: string): ManifestPlugin => ({
  name,
  package: "@databricks/appkit",
  resources: { required: [index], optional: [] },
});
const obo = { "vector_search_index:vector-search-index": "obo" } as const;

test("aiSearch sets columns and OBO auth on the default index", () => {
  const config = pluginConfig(plugin("aiSearch"), [index], obo, ["id", "t"]);
  expect(toSource(config)).toBe(
    `{ indexes: { default: { columns: ["id", "t"], auth: "on-behalf-of-user" } } }`,
  );
  expect(pluginConfig(plugin("aiSearch"), [index], {}, ["id"])).toEqual({
    indexes: { default: { columns: ["id"] } },
  });
});

test("files OBO sets the plugin-level auth", () => {
  expect(pluginConfig(plugin("files"), [index], obo)).toEqual({
    auth: "on-behalf-of-user",
  });
});

test("no config for sp or plugins without an auth option", () => {
  expect(pluginConfig(plugin("files"), [index], {})).toBeUndefined();
  expect(pluginConfig(plugin("analytics"), [index], obo)).toBeUndefined();
});

test("toSource escapes strings and quotes non-identifier keys", () => {
  expect(toSource({ "a-b": ['x"); evil()'] })).toBe(
    `{ "a-b": ["x\\"); evil()"] }`,
  );
});

test("agents OBO sets plugin auth; resources that can't be OBO don't block it", () => {
  const experiment: ManifestResource = {
    type: "experiment",
    alias: "Experiment",
    resourceKey: "agents-mlflow-experiment",
  };
  const endpoint: ManifestResource = {
    type: "serving_endpoint",
    alias: "LLM",
    resourceKey: "agents-serving-endpoint",
    scope: "model-serving",
  };
  expect(
    pluginConfig(plugin("agents"), [endpoint, experiment], {
      "serving_endpoint:agents-serving-endpoint": "obo",
    }),
  ).toEqual({
    auth: "on-behalf-of-user",
  });
});

test("agents auth follows the model endpoint, not the skills volume", () => {
  const endpoint: ManifestResource = {
    type: "serving_endpoint",
    alias: "LLM",
    resourceKey: "agents-serving-endpoint",
    scope: "model-serving",
  };
  const skills: ManifestResource = {
    type: "volume",
    alias: "Skills",
    resourceKey: "agents-skills",
    scope: "files",
  };
  const modelObo = {
    "serving_endpoint:agents-serving-endpoint": "obo",
  } as const;
  expect(pluginConfig(plugin("agents"), [endpoint, skills], modelObo)).toEqual({
    auth: "on-behalf-of-user",
  });
  expect(
    pluginConfig(plugin("agents"), [endpoint, skills], {
      "volume:agents-skills": "obo",
    }),
  ).toBeUndefined();
});

test("envConflicts flags env names bound to another resource or value", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-add-"));
  fs.writeFileSync(path.join(cwd, ".env"), "A=old\nB=\n");
  fs.writeFileSync(
    path.join(cwd, "app.yaml"),
    "env:\n  - name: C\n    valueFrom: serving-endpoint\n  - name: D\n    valueFrom: same\n",
  );
  const plan = {
    dotEnv: [
      { env: "A", value: "new" },
      { env: "B", value: "x" },
    ],
    appYamlEnv: [
      { name: "C", valueFrom: "agents-serving-endpoint" },
      { name: "D", valueFrom: "same" },
    ],
    bundleVariables: [],
    resourceBindings: [],
    unverifiedTypes: [],
  };
  expect(envConflicts(cwd, plan)).toEqual(["A", "C"]);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test("files with mixed modes sets auth on the OBO volumes only", () => {
  const vol = (key: string, env: string): ManifestResource => ({
    type: "volume",
    alias: key,
    resourceKey: key,
    scope: "files",
    fields: { path: { env } },
  });
  const priv = vol("files", "DATABRICKS_VOLUME_FILES");
  const exp = vol("exports", "DATABRICKS_VOLUME_EXPORTS");
  expect(
    pluginConfig(plugin("files"), [priv, exp], { "volume:files": "obo" }),
  ).toEqual({ volumes: { files: { auth: "on-behalf-of-user" } } });
});
