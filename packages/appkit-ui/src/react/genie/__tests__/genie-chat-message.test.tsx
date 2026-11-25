import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../genie-query-visualization", () => ({
  GenieQueryVisualization: (props: {
    chartImageUrl?: string;
    chartImageAlt?: string;
  }) => (
    <div
      data-testid="query-result"
      data-chart-image={props.chartImageUrl}
      data-chart-alt={props.chartImageAlt}
    />
  ),
}));

import { GenieChatMessage } from "../genie-chat-message";
import type { GenieMessageItem, GenieStatementResponse } from "../types";

const queryResult: GenieStatementResponse = {
  manifest: { schema: { columns: [{ name: "country" }] } },
  result: { dataArray: [["Japan"]] },
};

function assistant(overrides: Partial<GenieMessageItem>): GenieMessageItem {
  return {
    id: "msg-1",
    role: "assistant",
    content: "Japan has the most.",
    status: "COMPLETED",
    attachments: [],
    queryResults: new Map(),
    ...overrides,
  };
}

describe("GenieChatMessage", () => {
  afterEach(cleanup);

  test("hands Genie's chart to the query result, which keeps its table", () => {
    render(
      <GenieChatMessage
        message={assistant({
          attachments: [
            { attachmentId: "query-1", query: { title: "Franchises" } },
            {
              attachmentId: "viz-1",
              viz: {
                title: "Franchises by Country",
                queryAttachmentId: "query-1",
              },
            },
          ],
          queryResults: new Map([["query-1", queryResult]]),
          visualizationUrls: { "viz-1": "/api/genie/a/viz-1.png" },
        })}
      />,
    );

    const result = screen.getByTestId("query-result");
    expect(result.getAttribute("data-chart-image")).toBe(
      "/api/genie/a/viz-1.png",
    );
    expect(screen.queryByRole("img")).toBeNull();
  });

  test("shows Genie's chart as an image while there's no query result", () => {
    render(
      <GenieChatMessage
        message={assistant({
          attachments: [
            { attachmentId: "query-1", query: { title: "Franchises" } },
            {
              attachmentId: "viz-1",
              viz: {
                title: "Franchises by Country",
                queryAttachmentId: "query-1",
              },
            },
          ],
          visualizationUrls: { "viz-1": "/api/genie/a/viz-1.png" },
        })}
      />,
    );

    const img = screen.getByRole("img", { name: "Franchises by Country" });
    expect(img.getAttribute("src")).toBe("/api/genie/a/viz-1.png");
    expect(screen.queryByTestId("query-result")).toBeNull();
  });

  test("describes a chat-mode chart by its query's description", () => {
    render(
      <GenieChatMessage
        message={assistant({
          attachments: [
            {
              attachmentId: "query-1",
              query: {
                description:
                  "You want to see the number of franchises by size.",
                query: "SELECT size, COUNT(*) FROM franchises GROUP BY size",
              },
            },
            { attachmentId: "viz-1", viz: { queryAttachmentId: "query-1" } },
          ],
          visualizationUrls: { "viz-1": "/api/genie/a/viz-1.png" },
        })}
      />,
    );

    expect(
      screen.getByRole("img", {
        name: "You want to see the number of franchises by size.",
      }),
    ).toBeTruthy();
  });

  test("names a chat-mode chart in the result by its query's title first", () => {
    render(
      <GenieChatMessage
        message={assistant({
          attachments: [
            {
              attachmentId: "query-1",
              query: { title: "Franchises", description: "Franchise counts." },
            },
            { attachmentId: "viz-1", viz: { queryAttachmentId: "query-1" } },
          ],
          queryResults: new Map([["query-1", queryResult]]),
          visualizationUrls: { "viz-1": "/api/genie/a/viz-1.png" },
        })}
      />,
    );

    expect(
      screen.getByTestId("query-result").getAttribute("data-chart-alt"),
    ).toBe("Franchises");
  });

  test("leaves the query result alone for a query without a visualization", () => {
    render(
      <GenieChatMessage
        message={assistant({
          attachments: [
            { attachmentId: "query-1", query: { title: "Franchises" } },
          ],
          queryResults: new Map([["query-1", queryResult]]),
        })}
      />,
    );

    const result = screen.getByTestId("query-result");
    expect(result.getAttribute("data-chart-image")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
  });

  test("shows the agent's reasoning", () => {
    render(
      <GenieChatMessage
        message={assistant({
          content: "",
          reasoning: ["Counting franchises."],
        })}
      />,
    );

    expect(screen.getByText("Thinking")).toBeTruthy();
    expect(screen.getByText("Counting franchises.")).toBeTruthy();
  });
});
