import type express from "express";
import type { IAuthManager } from "./auth";

export interface BasePlugin {
  name: string;
  abortActiveOperations?(): void;
  validateEnv(): void;
  setup(): Promise<void>;
  injectRoutes(router: express.Router): void;
  asUser(userToken: string): WithInjectedToken<BasePlugin>;
}

export type WithInjectedToken<T> = T & {
  asUser(token: string): T;
};

export interface BasePluginConfig {
  name?: string;
  host?: string;
}

export interface PluginConfig {
  config?: any;
  plugin: any;
}

export type PluginPhase = "core" | "normal" | "deferred";

export type PluginConstructor<
  C = any,
  I extends BasePlugin = BasePlugin,
  A = IAuthManager
> = (new (config: C, auth: A) => I) & {
  DEFAULT_CONFIG?: Record<string, any>;
};

export type ConfigFor<T> = T extends { DEFAULT_CONFIG: infer D }
  ? D
  : T extends new (...args: any) => { config: infer C }
  ? C
  : any;

// Optional config plugin definition (used internally)
export type OptionalConfigPluginDef<P extends PluginConstructor> = {
  plugin: P;
  config?: Partial<ConfigFor<P>>;
};

// Input plugin map type (used internally by DBX)
export type InputPluginMap = {
  [key: string]: OptionalConfigPluginDef<any> | undefined;
};

// DBX with plugins - extracts instances from plugin map
export type DBXWithPlugins<T extends InputPluginMap> = {
  [K in keyof T]: T[K] extends { plugin: PluginConstructor<any, infer I> }
    ? I
    : never;
};

export type PluginMap<U extends readonly PluginData<any, any, string>[]> = {
  [P in U[number] as P["name"]]: InstanceType<P["plugin"]>;
};

export type PluginData<T, U, N> = { plugin: T; config: U; name: N };
export type ToPlugin<T, U, N extends string> = (
  config?: U
) => PluginData<T, U, N>;