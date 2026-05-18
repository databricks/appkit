import type { BasePluginConfig } from "shared";

export interface ServerConfig extends BasePluginConfig {
  port?: number;
  staticPath?: string;
  host?: string;
  /**
   * Max request body size accepted by the built-in `express.json()`
   * middleware. Accepts any string the `bytes` library understands
   * (`"1mb"`, `"10mb"`, `"512kb"`, …). Defaults to `"1mb"` — high enough
   * for agent chat payloads and modest base64 uploads (the dev
   * playground's smart-dashboard "save view" screenshot is the
   * motivating case), low enough that an attacker can't trivially
   * exhaust memory by spamming oversized JSON. Raise it explicitly if
   * your app routinely posts larger JSON bodies.
   */
  bodyLimit?: string;
}
