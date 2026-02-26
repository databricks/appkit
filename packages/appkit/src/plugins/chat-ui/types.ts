import type { BasePluginConfig } from "shared";

export interface IChatUIConfig extends BasePluginConfig {
  /**
   * Path to a pre-built chatbot UI server module.
   * Defaults to resolving `@databricks/chatbot-ui/server` from the workspace.
   * Can be overridden to point at a custom chat server build.
   */
  uiServerPath?: string;

  /**
   * Agent endpoint URL that the chat backend proxies requests to.
   * Defaults to `/api/agent` (the standard AgentPlugin endpoint when running in-process).
   */
  agentEndpoint?: string;

  /**
   * Enable Lakebase-backed chat history persistence.
   * Requires a DATABASE resource (DATABRICKS_CHATDB_INSTANCE + DATABRICKS_CHATDB_NAME).
   * Defaults to false.
   */
  enablePersistence?: boolean;
}
