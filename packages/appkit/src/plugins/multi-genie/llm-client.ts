import { createLogger } from "../../logging/logger";

const logger = createLogger("multi-genie:llm");

export interface LLMTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: LLMToolCall[];
  tool_call_id?: string;
}

export interface LLMToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface LLMChoice {
  message: {
    role: "assistant";
    content: string | null;
    tool_calls?: LLMToolCall[];
  };
  finish_reason: string;
}

interface LLMResponse {
  choices: LLMChoice[];
}

export interface LLMClientConfig {
  endpoint: string;
  model: string;
  token: string;
}

export async function chatCompletion(
  config: LLMClientConfig,
  messages: LLMMessage[],
  tools?: LLMTool[],
  signal?: AbortSignal,
): Promise<LLMChoice["message"]> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
  };

  if (tools && tools.length > 0) {
    body.tools = tools;
  }

  logger.debug(
    "LLM request: model=%s messages=%d tools=%d",
    config.model,
    messages.length,
    tools?.length ?? 0,
  );

  const response = await fetch(config.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `LLM request failed: ${response.status} ${response.statusText}${text ? ` — ${text}` : ""}`,
    );
  }

  const data = (await response.json()) as LLMResponse;

  if (!data.choices?.[0]?.message) {
    throw new Error("LLM response missing choices[0].message");
  }

  return data.choices[0].message;
}
