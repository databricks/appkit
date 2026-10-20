import { expect, test } from "vitest";

import { pluginCallArgs } from "./add";
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

test("aiSearch OBO sets auth on the default index, where the routes read it", () => {
  expect(pluginCallArgs(plugin("aiSearch"), [index], obo)).toBe(
    `{ indexes: { default: { auth: "on-behalf-of-user" } } }`,
  );
});

test("files OBO sets the plugin-level auth", () => {
  expect(pluginCallArgs(plugin("files"), [index], obo)).toBe(
    `{ auth: "on-behalf-of-user" }`,
  );
});

test("no args for sp/both or plugins without an auth option", () => {
  expect(pluginCallArgs(plugin("aiSearch"), [index], {})).toBe("");
  expect(pluginCallArgs(plugin("analytics"), [index], obo)).toBe("");
});
