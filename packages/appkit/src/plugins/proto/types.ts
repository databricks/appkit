import type { BasePluginConfig } from "shared";

/** Configuration for the Proto plugin. */
export interface IProtoConfig extends BasePluginConfig {
  /** Default UC Volume path for proto binary I/O. */
  defaultVolume?: string;
  /** Timeout for volume operations in milliseconds. Default: 60000 */
  timeout?: number;
}
