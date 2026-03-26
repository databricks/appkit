import type {
  AgentAdapter,
  AgentToolDefinition,
  BasePluginConfig,
  ThreadStore,
  ToolProvider,
} from "shared";

export interface AgentPluginConfig extends BasePluginConfig {
  agents?: Record<string, AgentAdapter | Promise<AgentAdapter>>;
  defaultAgent?: string;
  threadStore?: ThreadStore;
  plugins?: Record<string, any>;
}

export interface ToolEntry {
  plugin: ToolProvider & { asUser(req: any): any };
  def: AgentToolDefinition;
  localName: string;
}

export type RegisteredAgent = {
  name: string;
  adapter: AgentAdapter;
};

export type {
  AgentAdapter,
  AgentToolDefinition,
  ToolProvider,
} from "shared";
