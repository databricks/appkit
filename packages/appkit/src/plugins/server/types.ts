import type { BasePluginConfig } from "shared";
import type { Plugin } from "../../plugin";

export interface ServerConfig extends BasePluginConfig {
  port?: number;
  plugins?: Record<string, Plugin>;
  staticPath?: string;
  autoStart?: boolean;
  host?: string;
  /**
   * Register HTTP and Express OpenTelemetry instrumentations.
   * When false, no HTTP/Express spans are created regardless of other
   * telemetry settings. Default: true.
   */
  enableDefaultTelemetry?: boolean;
}
