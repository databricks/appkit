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

export interface AgentDefinition {
  adapter: AgentAdapter | Promise<AgentAdapter>;
  systemPrompt?: string;
}

export type AgentEntry = AgentAdapter | AgentDefinition | Promise<AgentAdapter>;

export interface AgentPluginConfig extends BasePluginConfig {
  agents?: Record<string, AgentEntry>;
  defaultAgent?: string;
  threadStore?: ThreadStore;
  tools?: AgentTool[];
  agentsDir?: string;
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
  systemPrompt?: string;
};

export type {
  AgentAdapter,
  AgentToolDefinition,
  ToolProvider,
} from "shared";
