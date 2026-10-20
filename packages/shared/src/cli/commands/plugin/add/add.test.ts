import { expect, test } from "vitest";

import { pluginConfig, toSource } from "./add";
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
