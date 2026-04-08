import type {
  AgentAdapter,
  AgentToolDefinition,
  BasePluginConfig,
  ThreadStore,
  ToolProvider,
} from "shared";
import type { FunctionTool } from "./tools/function-tool";
import type { HostedTool } from "./tools/hosted-tools";

export type AgentTool = FunctionTool | HostedTool;

export interface AgentPluginConfig extends BasePluginConfig {
  agents?: Record<string, AgentAdapter | Promise<AgentAdapter>>;
  defaultAgent?: string;
  threadStore?: ThreadStore;
  tools?: AgentTool[];
  plugins?: Record<string, any>;
}

export type ToolEntry =
  | {
      source: "plugin";
      plugin: ToolProvider & { asUser(req: any): any };
      def: AgentToolDefinition;
      localName: string;
    }
  | {
      source: "function";
      functionTool: FunctionTool;
      def: AgentToolDefinition;
    }
  | {
      source: "mcp";
      mcpToolName: string;
      def: AgentToolDefinition;
    };

export type RegisteredAgent = {
  name: string;
  adapter: AgentAdapter;
};

export type {
  AgentAdapter,
  AgentToolDefinition,
  ToolProvider,
} from "shared";
