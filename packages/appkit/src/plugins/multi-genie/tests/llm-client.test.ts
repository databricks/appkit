import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  chatCompletion,
  type LLMClientConfig,
  type LLMMessage,
} from "../llm-client";

describe("chatCompletion", () => {
  const config: LLMClientConfig = {
    endpoint: "https://example.com/chat/completions",
    model: "test-model",
    token: "test-token",
  };

  const messages: LLMMessage[] = [
    { role: "system", content: "You are helpful." },
    { role: "user", content: "Hello" },
  ];

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("sends correct request and returns message", async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              role: "assistant",
              content: "Hello! How can I help?",
            },
            finish_reason: "stop",
          },
        ],
      }),
    };

    vi.mocked(fetch).mockResolvedValue(mockResponse as Response);

    const result = await chatCompletion(config, messages);

    expect(fetch).toHaveBeenCalledWith(config.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({
        model: "test-model",
        messages,
      }),
      signal: undefined,
    });

    expect(result.content).toBe("Hello! How can I help?");
  });

  test("includes tools when provided", async () => {
    const tools = [
      {
        type: "function" as const,
        function: {
          name: "query_sales",
          description: "Query sales",
          parameters: { type: "object", properties: {} },
        },
      },
    ];

    const mockResponse = {
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "tc-1",
                  type: "function",
                  function: {
                    name: "query_sales",
                    arguments: '{"question":"Q4 revenue"}',
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
    };

    vi.mocked(fetch).mockResolvedValue(mockResponse as Response);

    const result = await chatCompletion(config, messages, tools);

    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string);
    expect(body.tools).toEqual(tools);
    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls?.[0].function.name).toBe("query_sales");
  });

  test("throws on non-ok response", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => "Invalid token",
    } as Response);

    await expect(chatCompletion(config, messages)).rejects.toThrow(
      "LLM request failed: 401 Unauthorized — Invalid token",
    );
  });

  test("throws on missing choices", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [] }),
    } as unknown as Response);

    await expect(chatCompletion(config, messages)).rejects.toThrow(
      "LLM response missing choices[0].message",
    );
  });

  test("passes abort signal", async () => {
    const controller = new AbortController();

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
      }),
    } as unknown as Response);

    await chatCompletion(config, messages, undefined, controller.signal);

    expect(vi.mocked(fetch).mock.calls[0][1]?.signal).toBe(controller.signal);
  });
});
