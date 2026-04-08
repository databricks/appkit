import { afterEach, describe, expect, test, vi } from "vitest";
import {
  _resetConfigCache,
  getClientConfig,
  getPluginClientConfig,
} from "./config";

describe("js/config", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    _resetConfigCache();
  });

  test("parses runtime config from the DOM script payload", () => {
    document.body.innerHTML = `
      <script id="__appkit__" type="application/json">
        {"appName":"demo","queries":{"q":"q"},"endpoints":{"analytics":{"query":"/api/analytics/query"}},"plugins":{"analytics":{"warehouseId":"abc"}}}
      </script>
    `;

    expect(getClientConfig()).toEqual({
      appName: "demo",
      queries: { q: "q" },
      endpoints: { analytics: { query: "/api/analytics/query" } },
      plugins: { analytics: { warehouseId: "abc" } },
    });
    expect(getPluginClientConfig("analytics")).toEqual({ warehouseId: "abc" });
  });

  test("returns empty config when no script tag is present", () => {
    const config = getClientConfig();
    expect(config).toEqual({
      appName: "",
      queries: {},
      endpoints: {},
      plugins: {},
    });
  });

  test("returns empty config and warns on malformed JSON", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    document.body.innerHTML = `
      <script id="__appkit__" type="application/json">NOT VALID JSON</script>
    `;

    const config = getClientConfig();
    expect(config).toEqual({
      appName: "",
      queries: {},
      endpoints: {},
      plugins: {},
    });
    expect(warnSpy).toHaveBeenCalledWith(
      "[appkit] Failed to parse config from DOM:",
      expect.any(SyntaxError),
    );
    warnSpy.mockRestore();
  });

  test("caches parsed config across calls", () => {
    document.body.innerHTML = `
      <script id="__appkit__" type="application/json">
        {"appName":"cached","queries":{},"endpoints":{},"plugins":{}}
      </script>
    `;

    const first = getClientConfig();
    const second = getClientConfig();
    expect(first).toBe(second);
  });

  test("returns stable reference for missing plugin config", () => {
    document.body.innerHTML = `
      <script id="__appkit__" type="application/json">
        {"appName":"app","queries":{},"endpoints":{},"plugins":{}}
      </script>
    `;

    const a = getPluginClientConfig("nonexistent");
    const b = getPluginClientConfig("nonexistent");
    expect(a).toBe(b);
  });

  test("returns empty config when script tag has empty content", () => {
    document.body.innerHTML = `
      <script id="__appkit__" type="application/json"></script>
    `;

    const config = getClientConfig();
    expect(config).toEqual({
      appName: "",
      queries: {},
      endpoints: {},
      plugins: {},
    });
  });

  test("normalizes partial data with missing fields", () => {
    document.body.innerHTML = `
      <script id="__appkit__" type="application/json">
        {"appName":"partial"}
      </script>
    `;

    const config = getClientConfig();
    expect(config).toEqual({
      appName: "partial",
      queries: {},
      endpoints: {},
      plugins: {},
    });
  });
});
