import { describe, expect, test } from "vitest";
import { AgentEventTranslator } from "../event-translator";

describe("AgentEventTranslator", () => {
  test("translates message_delta to output_item.added + output_text.delta on first delta", () => {
    const translator = new AgentEventTranslator();
    const events = translator.translate({
      type: "message_delta",
      content: "Hello",
    });

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("response.output_item.added");
    expect(events[1].type).toBe("response.output_text.delta");

    if (events[1].type === "response.output_text.delta") {
      expect(events[1].delta).toBe("Hello");
    }
  });

  test("subsequent message_delta only produces output_text.delta", () => {
    const translator = new AgentEventTranslator();
    translator.translate({ type: "message_delta", content: "Hello" });
    const events = translator.translate({
      type: "message_delta",
      content: " world",
    });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("response.output_text.delta");
  });

  test("sequence_number is monotonically increasing", () => {
    const translator = new AgentEventTranslator();
    const e1 = translator.translate({ type: "message_delta", content: "a" });
    const e2 = translator.translate({ type: "message_delta", content: "b" });
    const e3 = translator.finalize();

    const allSeqs = [...e1, ...e2, ...e3].map((e) =>
      "sequence_number" in e ? e.sequence_number : -1,
    );

    for (let i = 1; i < allSeqs.length; i++) {
      expect(allSeqs[i]).toBeGreaterThan(allSeqs[i - 1]);
    }
  });

  test("translates tool_call to paired output_item.added + output_item.done", () => {
    const translator = new AgentEventTranslator();
    const events = translator.translate({
      type: "tool_call",
      callId: "call_1",
      name: "analytics.query",
      args: { sql: "SELECT 1" },
    });

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("response.output_item.added");
    expect(events[1].type).toBe("response.output_item.done");

    if (events[0].type === "response.output_item.added") {
      expect(events[0].item.type).toBe("function_call");
      if (events[0].item.type === "function_call") {
        expect(events[0].item.name).toBe("analytics.query");
        expect(events[0].item.call_id).toBe("call_1");
      }
    }
  });

  test("translates tool_result to paired output_item events", () => {
    const translator = new AgentEventTranslator();
    const events = translator.translate({
      type: "tool_result",
      callId: "call_1",
      result: { rows: 42 },
    });

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("response.output_item.added");

    if (events[0].type === "response.output_item.added") {
      expect(events[0].item.type).toBe("function_call_output");
    }
  });

  test("translates tool_result error", () => {
    const translator = new AgentEventTranslator();
    const events = translator.translate({
      type: "tool_result",
      callId: "call_1",
      result: null,
      error: "Query failed",
    });

    if (
      events[0].type === "response.output_item.added" &&
      events[0].item.type === "function_call_output"
    ) {
      expect(events[0].item.output).toBe("Query failed");
    }
  });

  test("translates thinking to appkit.thinking extension event", () => {
    const translator = new AgentEventTranslator();
    const events = translator.translate({
      type: "thinking",
      content: "Let me think about this...",
    });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("appkit.thinking");
    if (events[0].type === "appkit.thinking") {
      expect(events[0].content).toBe("Let me think about this...");
    }
  });

  test("translates metadata to appkit.metadata extension event", () => {
    const translator = new AgentEventTranslator();
    const events = translator.translate({
      type: "metadata",
      data: { threadId: "t-123" },
    });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("appkit.metadata");
    if (events[0].type === "appkit.metadata") {
      expect(events[0].data.threadId).toBe("t-123");
    }
  });

  test("status:complete triggers finalize with response.completed", () => {
    const translator = new AgentEventTranslator();
    translator.translate({ type: "message_delta", content: "Hi" });
    const events = translator.translate({ type: "status", status: "complete" });

    const types = events.map((e) => e.type);
    expect(types).toContain("response.output_item.done");
    expect(types).toContain("response.completed");
  });

  test("status:error emits error + response.failed", () => {
    const translator = new AgentEventTranslator();
    const events = translator.translate({
      type: "status",
      status: "error",
      error: "Something broke",
    });

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("error");
    expect(events[1].type).toBe("response.failed");

    if (events[0].type === "error") {
      expect(events[0].error).toBe("Something broke");
    }
  });

  test("finalize produces response.completed", () => {
    const translator = new AgentEventTranslator();
    const events = translator.finalize();

    expect(events.some((e) => e.type === "response.completed")).toBe(true);
  });

  test("finalize with accumulated message text produces output_item.done", () => {
    const translator = new AgentEventTranslator();
    translator.translate({ type: "message_delta", content: "Hello " });
    translator.translate({ type: "message_delta", content: "world" });
    const events = translator.finalize();

    const doneEvent = events.find(
      (e) => e.type === "response.output_item.done",
    );
    expect(doneEvent).toBeDefined();
    if (
      doneEvent?.type === "response.output_item.done" &&
      doneEvent.item.type === "message"
    ) {
      expect(doneEvent.item.content[0].text).toBe("Hello world");
    }
  });

  test("output_index increments for tool calls", () => {
    const translator = new AgentEventTranslator();
    const e1 = translator.translate({
      type: "tool_call",
      callId: "c1",
      name: "tool1",
      args: {},
    });
    const e2 = translator.translate({
      type: "tool_result",
      callId: "c1",
      result: "ok",
    });

    if (
      e1[0].type === "response.output_item.added" &&
      e2[0].type === "response.output_item.added"
    ) {
      expect(e2[0].output_index).toBeGreaterThan(e1[0].output_index);
    }
  });
});
