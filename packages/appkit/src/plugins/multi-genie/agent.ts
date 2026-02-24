import { getWorkspaceClient } from "../../context";
import { createLogger } from "../../logging/logger";
import type { GeniePlugin } from "../genie/genie";
import {
  chatCompletion,
  type LLMClientConfig,
  type LLMMessage,
  type LLMTool,
} from "./llm-client";
import { buildSystemPrompt } from "./prompt";
import { aliasFromToolName, buildGenieSpaceTools } from "./tools";
import type { IMultiGenieConfig, MultiGenieStreamEvent } from "./types";

const logger = createLogger("multi-genie:agent");

interface AgentDeps {
  config: IMultiGenieConfig;
  geniePlugin: GeniePlugin;
  signal?: AbortSignal;
}

/**
 * Supervisor agent loop: routes sub-questions to Genie spaces via LLM tool calling,
 * fetches query results, and synthesizes a unified answer.
 * Yields SSE events at each step so the frontend can show progress.
 */
export async function* runAgent(
  userMessage: string,
  deps: AgentDeps,
): AsyncGenerator<MultiGenieStreamEvent> {
  const { config, geniePlugin, signal } = deps;
  const maxIterations = config.maxIterations ?? 5;

  const token = config.endpointToken ?? process.env.DATABRICKS_TOKEN ?? "";
  if (!token) {
    yield { type: "error", error: "No endpoint token configured" };
    return;
  }

  const llmConfig: LLMClientConfig = {
    endpoint: config.endpoint,
    model: config.model ?? "default",
    token,
  };

  const tools: LLMTool[] = buildGenieSpaceTools(
    config.genieSpaces,
    config.genieSpaceDescriptions,
  );

  const systemPrompt =
    config.systemPrompt ??
    buildSystemPrompt(config.genieSpaces, config.genieSpaceDescriptions);

  const messages: LLMMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];

  yield { type: "agent_start", userMessage };

  // Reuse per-space Genie conversations within a single request
  const genieSpaceConversations = new Map<string, string>();

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    yield { type: "agent_thinking", iteration };

    const response = await chatCompletion(llmConfig, messages, tools, signal);

    if (!response.tool_calls || response.tool_calls.length === 0) {
      yield { type: "answer", content: response.content ?? "" };
      return;
    }

    messages.push({
      role: "assistant",
      content: response.content,
      tool_calls: response.tool_calls,
    });

    const aliases = response.tool_calls
      .map((tc) => aliasFromToolName(tc.function.name))
      .filter((a): a is string => a !== null);

    if (aliases.length > 0) {
      yield { type: "routing", genieSpaces: aliases };
    }

    const toolResults = await Promise.all(
      response.tool_calls.map((toolCall) =>
        executeToolCall(toolCall, config, geniePlugin, genieSpaceConversations),
      ),
    );

    for (const result of toolResults) {
      for (const event of result.events) {
        yield event;
      }
      messages.push({
        role: "tool",
        tool_call_id: result.toolCallId,
        content: result.content,
      });
    }
  }

  // Max iterations reached — force a final answer without tools
  yield { type: "agent_thinking", iteration: maxIterations };
  const finalResponse = await chatCompletion(
    llmConfig,
    messages,
    undefined,
    signal,
  );
  yield { type: "answer", content: finalResponse.content ?? "" };
}

interface ToolCallResult {
  toolCallId: string;
  content: string;
  events: MultiGenieStreamEvent[];
}

async function executeToolCall(
  toolCall: { id: string; function: { name: string; arguments: string } },
  config: IMultiGenieConfig,
  geniePlugin: GeniePlugin,
  genieSpaceConversations: Map<string, string>,
): Promise<ToolCallResult> {
  const alias = aliasFromToolName(toolCall.function.name);
  if (!alias || !config.genieSpaces[alias]) {
    return {
      toolCallId: toolCall.id,
      content: `Unknown genie space: ${toolCall.function.name}`,
      events: [],
    };
  }

  let question: string;
  try {
    question = JSON.parse(toolCall.function.arguments).question;
  } catch {
    return {
      toolCallId: toolCall.id,
      content: `Invalid tool arguments: ${toolCall.function.arguments}`,
      events: [],
    };
  }

  const events: MultiGenieStreamEvent[] = [];

  try {
    const result = await geniePlugin.sendMessage(
      alias,
      question,
      genieSpaceConversations.get(alias),
    );
    genieSpaceConversations.set(alias, result.conversationId);

    const attachments = result.attachments ?? [];

    // Genie puts the AI answer in text attachments, not in content
    const textParts = attachments
      .map((att) => att.text?.content)
      .filter(Boolean) as string[];
    const displayContent =
      textParts.length > 0 ? textParts.join("\n\n") : result.content;

    events.push({
      type: "genie_space_result",
      alias,
      spaceId: result.spaceId,
      conversationId: result.conversationId,
      messageId: result.messageId,
      content: displayContent,
      attachments,
      status: result.status,
    });

    // Fetch actual query result rows for each SQL attachment
    const workspaceClient = getWorkspaceClient();
    for (const att of attachments) {
      const attachmentId = att.attachmentId;
      const statementId = att.query?.statementId;
      if (!attachmentId || !statementId) continue;

      try {
        const queryResult =
          await workspaceClient.genie.getMessageAttachmentQueryResult({
            space_id: result.spaceId,
            conversation_id: result.conversationId,
            message_id: result.messageId,
            attachment_id: attachmentId,
          });

        events.push({
          type: "genie_query_result",
          alias,
          attachmentId,
          statementId,
          data: queryResult.statement_response,
        });
      } catch (err) {
        logger.error(
          "Failed to fetch query result for %s/%s: %O",
          alias,
          attachmentId,
          err,
        );
      }
    }

    // Build text summary for the LLM (it doesn't need raw row data)
    const sqlSummary = attachments
      .filter((att) => att.query?.title)
      .map(
        (att) =>
          `[Query: ${att.query?.title}] SQL: ${att.query?.query ?? "N/A"}`,
      )
      .join("\n");

    const toolText = displayContent + (sqlSummary ? `\n\n${sqlSummary}` : "");

    return { toolCallId: toolCall.id, content: toolText, events };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Genie query failed";
    logger.error("Genie space query failed for %s: %O", alias, err);
    events.push({ type: "genie_space_error", alias, error: errorMsg });
    return {
      toolCallId: toolCall.id,
      content: `Error querying genie space ${alias}: ${errorMsg}`,
      events,
    };
  }
}
