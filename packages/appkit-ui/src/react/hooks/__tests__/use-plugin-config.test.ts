import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { _resetConfigCache } from "@/js/config";
import { usePluginClientConfig } from "../use-plugin-config";

describe("usePluginClientConfig", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    _resetConfigCache();
  });

  test("returns typed plugin config from the boot payload", () => {
    document.body.innerHTML = `
      <script id="__appkit__" type="application/json">
        {"appName":"app","queries":{},"endpoints":{},"plugins":{"files":{"volumes":["vol-a","vol-b"]}}}
      </script>
    `;

    interface FilesConfig {
      volumes: string[];
    }

    const { result } = renderHook(() =>
      usePluginClientConfig<FilesConfig>("files"),
    );

    expect(result.current).toEqual({ volumes: ["vol-a", "vol-b"] });
  });

  test("returns empty object for unknown plugin", () => {
    document.body.innerHTML = `
      <script id="__appkit__" type="application/json">
        {"appName":"app","queries":{},"endpoints":{},"plugins":{}}
      </script>
    `;

    const { result } = renderHook(() => usePluginClientConfig("unknown"));

    expect(result.current).toEqual({});
  });

  test("returns stable reference across re-renders", () => {
    document.body.innerHTML = `
      <script id="__appkit__" type="application/json">
        {"appName":"app","queries":{},"endpoints":{},"plugins":{"genie":{"spaceId":"s1"}}}
      </script>
    `;

    const { result, rerender } = renderHook(() =>
      usePluginClientConfig("genie"),
    );

    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
