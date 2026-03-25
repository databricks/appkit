import { describe, expect, test } from "vitest";
import { createArtifactPaths } from "../artifact-paths";

describe("createArtifactPaths", () => {
  const paths = createArtifactPaths("/Volumes/main/default/apps_mcp_generated");

  test("appZip follows naming convention", () => {
    expect(paths.appZip("123", "property_search")).toBe(
      "/Volumes/main/default/apps_mcp_generated/run_123_property_search.zip",
    );
  });

  test("evalResult uses .pb extension", () => {
    expect(paths.evalResult("123", "property_search")).toBe(
      "/Volumes/main/default/apps_mcp_generated/run_123_property_search_eval.pb",
    );
  });

  test("editedAppZip includes edit name", () => {
    expect(paths.editedAppZip("123", "add_emoji", "property_search")).toBe(
      "/Volumes/main/default/apps_mcp_generated/run_123_add_emoji_property_search.zip",
    );
  });

  test("editEvalResult includes edit name", () => {
    expect(paths.editEvalResult("123", "add_emoji", "property_search")).toBe(
      "/Volumes/main/default/apps_mcp_generated/run_123_add_emoji_property_search_edit_eval.pb",
    );
  });

  test("generationResult path", () => {
    expect(paths.generationResult("123", "my_app")).toBe(
      "/Volumes/main/default/apps_mcp_generated/run_123_my_app_gen.pb",
    );
  });

  test("aggregateReport path", () => {
    expect(paths.aggregateReport("123")).toBe(
      "/Volumes/main/default/apps_mcp_generated/run_123_aggregate.pb",
    );
  });

  test("trajectory path", () => {
    expect(paths.trajectory("123", "my_app")).toBe(
      "/Volumes/main/default/apps_mcp_generated/run_123_my_app_trajectory.pb",
    );
  });

  test("pipelineConfig path", () => {
    expect(paths.pipelineConfig("123")).toBe(
      "/Volumes/main/default/apps_mcp_generated/run_123_config.pb",
    );
  });

  test("strips trailing slash from volume base", () => {
    const p = createArtifactPaths("/Volumes/main/default/vol/");
    expect(p.appZip("1", "app")).toBe(
      "/Volumes/main/default/vol/run_1_app.zip",
    );
  });
});
