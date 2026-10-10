import { expect, test } from "e2e";

import {
  DISTINCT_SP,
  NEEDS_DISTINCT_SP,
  postSse,
  SERVER_IDENTITY,
  type SseEvent,
  SP_CLIENT_ID,
  USER_EMAIL,
  userHeaders,
} from "./env";

// The app's own model decides to call the tools; the assertions only read tool outputs.
const PROMPT = "Who am I? Prove identity with both tools.";

/** Tool name -> parsed output, joined from function_call and function_call_output items. */
function toolOutputs(events: SseEvent[]): Record<string, any> {
  const items = events
    .filter((e) => e.data?.type === "response.output_item.done")
    .map((e) => e.data.item);
  const names = new Map(
    items
      .filter((i) => i?.type === "function_call")
      .map((i) => [i.call_id, i.name]),
  );
  const outputs: Record<string, any> = {};
  for (const item of items.filter((i) => i?.type === "function_call_output")) {
    try {
      outputs[names.get(item.call_id)] = JSON.parse(item.output);
    } catch {
      outputs[names.get(item.call_id)] = item.output;
    }
  }
  return outputs;
}

async function chat(
  baseUrl: string | undefined,
  headers?: Record<string, string>,
) {
  const res = await postSse(
    new URL("/api/agents/chat", baseUrl),
    { message: PROMPT },
    headers,
  );
  return { ...res, outputs: toolOutputs(res.events) };
}

test.describe("agents execution identity", () => {
  test("B5: a plugin-toolkit tool runs as the user", async ({ app }) => {
    test.skip(!DISTINCT_SP, NEEDS_DISTINCT_SP);
    const { status, outputs } = await chat(app.baseUrl, userHeaders);
    expect(status).toBe(200);
    expect(JSON.stringify(outputs["analytics.query"])).toContain(USER_EMAIL);
    expect(JSON.stringify(outputs["analytics.query"])).not.toContain(
      SP_CLIENT_ID,
    );
  });

  test("B5: a hand-rolled tool and the model call run as the SP", async ({
    app,
  }) => {
    const { status, outputs, text } = await chat(app.baseUrl, userHeaders);
    expect(status).toBe(200);
    expect(outputs.whoami_sp).toMatchObject({ principal: "app" });
    // The model call ran (it chose the tools) with no model-serving user scope: SP.
    expect(text).not.toMatch(/^event: error$/m);
  });

  test("fail-closed: a plugin tool call with no user token never runs as the SP", async ({
    app,
  }) => {
    // A signed-in user whose token did not arrive: only the token is missing.
    const { "x-forwarded-access-token": _, ...noToken } = userHeaders;
    const { status, outputs } = await chat(app.baseUrl, noToken);
    expect(status).toBe(200);
    // The tool was called and answered with the token error, not with the server's rows.
    const query = JSON.stringify(outputs["analytics.query"]);
    expect(query).toMatch(/token/i);
    expect(query).not.toContain(SERVER_IDENTITY);
  });
});
