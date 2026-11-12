import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { GenieStreamEvent } from "../types";

// Capture the SSE callbacks so the test can play server events.
let onMessage: ((msg: { data: string }) => Promise<void>) | undefined;
const mockConnectSSE = vi.fn().mockImplementation((opts: any) => {
  onMessage = opts.onMessage;
  return new Promise<void>(() => {});
});

vi.mock("@/js", () => ({
  connectSSE: (...args: unknown[]) => mockConnectSSE(...args),
}));

import { useGenieChat } from "../use-genie-chat";

async function emit(event: GenieStreamEvent) {
  await act(async () => {
    await onMessage?.({ data: JSON.stringify(event) });
  });
}

describe("useGenieChat", () => {
  afterEach(() => {
    mockConnectSSE.mockClear();
  });

  test("shows reasoning while streaming and links visualizations to the plugin route", async () => {
    const { result } = renderHook(() =>
      useGenieChat({
        alias: "my agent",
        basePath: "/api/genie",
        persistInUrl: false,
      }),
    );

    act(() => result.current.sendMessage("Franchises by country?"));
    await emit({
      type: "message_start",
      conversationId: "conv-1",
      messageId: "msg-1",
      spaceId: "s",
    });
    await emit({ type: "reasoning", content: "Counting franchises." });
    await emit({ type: "reasoning", content: "Charting them." });

    expect(result.current.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "",
      reasoning: ["Counting franchises.", "Charting them."],
    });

    await emit({
      type: "message_result",
      message: {
        messageId: "msg-1",
        conversationId: "conv-1",
        spaceId: "s",
        status: "COMPLETED",
        content: "Franchises by country?",
        attachments: [
          { attachmentId: "query-1", query: { title: "Franchises" } },
          {
            attachmentId: "viz-1_output",
            viz: { title: "Chart", queryAttachmentId: "query-1" },
          },
          { text: { content: "Japan has the most." } },
        ],
        reasoning: ["Counting franchises.", "Charting them."],
      },
    });

    expect(result.current.messages.at(-1)).toMatchObject({
      id: "msg-1",
      content: "Japan has the most.",
      reasoning: ["Counting franchises.", "Charting them."],
      visualizationUrls: {
        "viz-1_output":
          "/api/genie/my%20agent/conversations/conv-1/messages/msg-1/attachments/viz-1_output/visualization",
      },
    });
  });
});
