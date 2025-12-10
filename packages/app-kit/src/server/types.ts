import type { BasePluginConfig } from "shared";
import type { Plugin } from "../plugin";

export interface ServerConfig extends BasePluginConfig {
  port?: number;
  plugins?: Record<string, Plugin>;
  staticPath?: string;
  autoStart?: boolean;
  host?: string;
}
