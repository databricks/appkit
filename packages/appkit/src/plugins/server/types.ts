import type { BasePluginConfig } from "shared";

export interface ServerConfig extends BasePluginConfig {
  port?: number;
  staticPath?: string;
  host?: string;
}
