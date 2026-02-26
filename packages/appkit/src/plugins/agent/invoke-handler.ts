/**
 * Responses API invoke handler for the LangGraph agent.
 *
 * Ported from ~/app-templates/agent-langchain-ts/src/framework/routes/invocations.ts
 *
 * Accepts Responses API request format, runs the LangGraph agent,
 * and streams events in Responses API SSE format.
 */

import { randomUUID } from "node:crypto";
import {
  type BaseMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import type express from "express";
import { z } from "zod";

/**
 * The minimal interface the invoke handler needs from the agent.
 * Matches the shape returned by createReactAgent from @langchain/langgraph/prebuilt.
 */
export interface InvokableAgent {
  invoke(input: {
    messages: BaseMessage[];
  }): Promise<{ messages: BaseMessage[] }>;
  streamEvents(
    input: { messages: BaseMessage[] },
    options: { version: "v1" | "v2" },
  ): AsyncIterable<{ event: string; name: string; run_id: string; data?: any }>;
}

/**
 * Responses API request schema.
 * Supports both text content and tool call messages in history.
 */
const responsesRequestSchema = z.object({
  input: z.array(
    z.union([
      z.object({
        role: z.enum(["user", "assistant", "system"]),
        content: z.union([
          z.string(),
          z.array(
            z.union([
              z.object({ type: z.string(), text: z.string() }).passthrough(),
              z.object({ type: z.string() }).passthrough(),
            ]),
          ),
        ]),
      }),
      z.object({ type: z.string() }).passthrough(),
    ]),
  ),
  stream: z.boolean().optional().default(true),
  custom_inputs: z.record(z.string(), z.any()).optional(),
});

function emitSSEEvent(
  res: express.Response,
  type: string,
  data: Record<string, unknown>,
) {
  res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
}

function emitOutputItem(
  res: express.Response,
  itemType: string,
  item: Record<string, unknown>,
) {
  emitSSEEvent(res, "response.output_item.added", {
    item: { ...item, type: itemType },
  });
  emitSSEEvent(res, "response.output_item.done", {
    item: { ...item, type: itemType },
  });
}

/**
 * Convert plain message objects from Responses API chat history to LangChain BaseMessage objects.
 */
function toBaseMessages(
  chatHistory: any[],
  systemPrompt: string,
): BaseMessage[] {
  const messages: BaseMessage[] = [new SystemMessage(systemPrompt)];

  for (const item of chatHistory) {
    // Handle top-level tool call objects
    if (item.type === "function_call") {
      messages.push(
        new (SystemMessage as any)(
          `[Tool Call: ${item.name}(${item.arguments})]`,
        ),
      );
      continue;
    }
    if (item.type === "function_call_output") {
      messages.push(
        new (SystemMessage as any)(`[Tool Result: ${item.output}]`),
      );
      continue;
    }

    // Handle message objects with array content
    let content: string;
    if (Array.isArray(item.content)) {
      const textParts = item.content
        .filter(
          (p: any) =>
            p.type === "input_text" ||
            p.type === "output_text" ||
            p.type === "text",
        )
        .map((p: any) => p.text);
      const toolParts = item.content
        .filter(
          (p: any) =>
            p.type === "function_call" || p.type === "function_call_output",
        )
        .map((p: any) =>
          p.type === "function_call"
            ? `[Tool Call: ${p.name}(${JSON.stringify(p.arguments)})]`
            : `[Tool Result: ${p.output}]`,
        );
      content = [...textParts, ...toolParts].filter(Boolean).join("\n");
    } else {
      content = item.content ?? "";
    }

    if (item.role === "user") {
      messages.push(new HumanMessage(content));
    } else {
      // assistant, system, or unrecognized — use SystemMessage as generic
      messages.push(new SystemMessage(content));
    }
  }

  return messages;
}

/**
 * Create an Express request handler that invokes the agent and streams
 * the response in Responses API SSE format.
 *
 * @param getAgent - Getter for the agent instance (called per request to support lazy init)
 * @param getSystemPrompt - Getter for the system prompt
 */
export function createInvokeHandler(
  getAgent: () => InvokableAgent,
  getSystemPrompt: () => string = () =>
    "You are a helpful AI assistant with access to various tools.",
): express.RequestHandler {
  return async (req: express.Request, res: express.Response) => {
    try {
      const parsed = responsesRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid request format",
          details: parsed.error.format(),
        });
        return;
      }

      const { input, stream } = parsed.data;

      // Extract the last user message as the current input
      const userMessages = input.filter((msg: any) => msg.role === "user");
      if (userMessages.length === 0) {
        res.status(400).json({ error: "No user message found in input" });
        return;
      }

      const lastUserMessage = userMessages[userMessages.length - 1];
      let userInput: string;
      if (Array.isArray(lastUserMessage.content)) {
        userInput = lastUserMessage.content
          .filter(
            (part: any) => part.type === "input_text" || part.type === "text",
          )
          .map((part: any) => part.text)
          .join("\n");
      } else {
        userInput = lastUserMessage.content as string;
      }

      // Build full message list: system prompt + chat history + current user message
      const chatHistory = input.slice(0, -1);
      const messages = [
        ...toBaseMessages(chatHistory, getSystemPrompt()),
        new HumanMessage(userInput),
      ];

      const agent = getAgent();

      if (stream) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");

        const textOutputId = `text_${randomUUID()}`;
        const toolCallIds = new Map<string, string>();

        try {
          const eventStream = agent.streamEvents(
            { messages },
            { version: "v2" },
          );

          for await (const event of eventStream) {
            if (event.event === "on_tool_start") {
              const toolCallId = `call_${randomUUID()}`;
              const fcId = `fc_${randomUUID()}`;
              const toolKey = `${event.name}_${event.run_id}`;
              toolCallIds.set(toolKey, toolCallId);

              emitOutputItem(res, "function_call", {
                id: fcId,
                call_id: toolCallId,
                name: event.name,
                arguments: JSON.stringify(event.data?.input || {}),
              });
            }

            if (event.event === "on_tool_end") {
              const toolKey = `${event.name}_${event.run_id}`;
              const toolCallId =
                toolCallIds.get(toolKey) ?? `call_${randomUUID()}`;
              toolCallIds.delete(toolKey);

              emitOutputItem(res, "function_call_output", {
                id: `fc_output_${randomUUID()}`,
                call_id: toolCallId,
                output: JSON.stringify(event.data?.output ?? ""),
              });
            }

            if (event.event === "on_chat_model_stream") {
              const content = event.data?.chunk?.content;
              if (content && typeof content === "string") {
                res.write(
                  `data: ${JSON.stringify({
                    type: "response.output_text.delta",
                    item_id: textOutputId,
                    delta: content,
                  })}\n\n`,
                );
              }
            }
          }

          toolCallIds.clear();
          res.write(
            `data: ${JSON.stringify({ type: "response.completed" })}\n\n`,
          );
          res.write("data: [DONE]\n\n");
          res.end();
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          toolCallIds.clear();
          res.write(
            `data: ${JSON.stringify({ type: "error", error: message })}\n\n`,
          );
          res.write(`data: ${JSON.stringify({ type: "response.failed" })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        }
      } else {
        // Non-streaming: invoke agent and return full response
        const result = await agent.invoke({ messages });
        const finalMessages = result.messages ?? [];
        const lastMsg = finalMessages[finalMessages.length - 1];
        const output =
          typeof lastMsg?.content === "string" ? lastMsg.content : "";

        res.json({ output });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: "Internal server error", message });
    }
  };
}
