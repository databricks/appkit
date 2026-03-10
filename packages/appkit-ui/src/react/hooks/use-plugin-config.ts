import { useMemo } from "react";
import { getPluginClientConfig } from "@/js";

/**
 * Returns the client-side config exposed by a plugin's `clientConfig()` method.
 *
 * The value is read once from the boot-time `<script id="__appkit__">` payload
 * and cached for the lifetime of the component. Because `clientConfig()` runs
 * at server startup, the data is static and never changes during a session.
 *
 * @param pluginName - The plugin name as registered in AppKit (e.g. `"files"`)
 * @returns The plugin's client config object, typed via the generic parameter
 *
 * @example
 * ```tsx
 * interface FilesConfig { volumes: string[] }
 *
 * function MyComponent() {
 *   const { volumes } = usePluginClientConfig<FilesConfig>("files");
 *   return <ul>{volumes.map(v => <li key={v}>{v}</li>)}</ul>;
 * }
 * ```
 */
export function usePluginClientConfig<T = Record<string, unknown>>(
  pluginName: string,
): T {
  return useMemo(() => getPluginClientConfig<T>(pluginName), [pluginName]);
}
