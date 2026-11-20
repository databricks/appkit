import DOMPurify from "dompurify";
import { marked } from "marked";
import { useMemo } from "react";

import { cn } from "../lib/utils";
import { Avatar, AvatarFallback } from "../ui/avatar";
import { Card } from "../ui/card";
import { GenieQueryVisualization } from "./genie-query-visualization";
import type { GenieAttachmentResponse, GenieMessageItem } from "./types";

/**
 * Using `marked` instead of `react-markdown` because `react-markdown` depends on
 * `micromark-util-symbol` which has broken ESM exports with `rolldown-vite`.
 * Output is sanitized with DOMPurify before being passed to `dangerouslySetInnerHTML`.
 */
marked.setOptions({ breaks: true, gfm: true });

const markdownStyles = cn(
  "text-sm break-words",
  "[&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0",
  "[&_pre]:bg-background/50 [&_pre]:p-2 [&_pre]:rounded [&_pre]:text-xs [&_pre]:overflow-x-auto",
  "[&_code]:text-xs [&_code]:bg-background/50 [&_code]:px-1 [&_code]:rounded",
  "[&_table]:text-xs [&_table]:block [&_table]:overflow-x-auto [&_table]:max-w-full",
  "[&_th]:px-2 [&_th]:py-1 [&_td]:px-2 [&_td]:py-1",
  "[&_table]:border-collapse [&_th]:border [&_td]:border",
  "[&_th]:border-border [&_td]:border-border",
  "[&_a]:underline",
);

interface GenieChatMessageProps {
  /** The message object to render */
  message: GenieMessageItem;
  /** Additional CSS class */
  className?: string;
}

function isQueryAttachment(att: GenieAttachmentResponse): boolean {
  return !!(att.query?.title || att.query?.query);
}

interface Visualization {
  url: string;
  title?: string;
  queryAttachmentId?: string;
}

/** A chart Genie rendered, shown as the PNG the genie plugin serves. */
function GenieVisualizationImage({ viz }: { viz: Visualization }) {
  return (
    <Card className="w-full px-4 py-3 overflow-hidden">
      <img
        src={viz.url}
        alt={viz.title ?? "Visualization"}
        loading="lazy"
        className="w-full h-auto"
      />
    </Card>
  );
}

/** Renders a single Genie message bubble with optional expandable SQL query attachments. */
export function GenieChatMessage({
  message,
  className,
}: GenieChatMessageProps) {
  const isUser = message.role === "user";
  const queryAttachments = message.attachments.filter(isQueryAttachment);
  const queryById = new Map(
    queryAttachments.map((att) => [att.attachmentId, att.query]),
  );
  const visualizations: Visualization[] = message.attachments.flatMap((att) => {
    const url =
      att.attachmentId && message.visualizationUrls?.[att.attachmentId];
    if (!att.viz || !url) return [];
    const query = queryById.get(att.viz.queryAttachmentId);
    // Chat-mode charts have no title; describe them by the query they plot.
    const title = att.viz.title || query?.title || query?.description;
    return [{ url, ...att.viz, title }];
  });
  // Charts whose query isn't among the attachments still get shown, after the queries.
  const unmatchedVisualizations = visualizations.filter(
    (viz) => !queryById.has(viz.queryAttachmentId),
  );
  const html = useMemo(
    () =>
      message.content
        ? DOMPurify.sanitize(marked.parse(message.content) as string)
        : "",
    [message.content],
  );

  return (
    <div
      className={cn(
        "flex gap-3",
        isUser ? "flex-row-reverse" : "flex-row",
        className,
      )}
    >
      <Avatar className="h-8 w-8 shrink-0 mt-1">
        <AvatarFallback
          className={cn(
            "text-xs font-medium",
            isUser ? "bg-primary text-primary-foreground" : "bg-muted",
          )}
        >
          {isUser ? "You" : "AI"}
        </AvatarFallback>
      </Avatar>

      <div className="flex flex-col gap-2 max-w-[80%] min-w-0 overflow-hidden">
        <Card
          className={cn(
            "w-full px-4 py-3 overflow-hidden",
            isUser
              ? "bg-primary text-primary-foreground [&_*::selection]:bg-primary-foreground/30 [&::selection]:bg-primary-foreground/30"
              : "bg-muted",
          )}
        >
          {message.reasoning && message.reasoning.length > 0 && (
            <details
              open={!message.content}
              className="text-xs text-muted-foreground mb-2"
            >
              <summary className="cursor-pointer select-none font-medium">
                Thinking
              </summary>
              <ul className="mt-1 flex flex-col gap-1 list-disc pl-4">
                {message.reasoning.map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ul>
            </details>
          )}

          {html && (
            <div
              className={markdownStyles}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          )}

          {message.error && (
            <p className="text-sm text-destructive mt-1">{message.error}</p>
          )}
        </Card>

        {queryAttachments.length > 0 && (
          <div className="flex flex-col gap-2 w-full min-w-0">
            {queryAttachments.map((att) => {
              const key = att.attachmentId ?? "query";
              const queryResult = att.attachmentId
                ? message.queryResults.get(att.attachmentId)
                : undefined;
              const queryVisualizations = visualizations.filter(
                (viz) => viz.queryAttachmentId === att.attachmentId,
              );
              // The first chart goes into the result's Chart tab; any others, or all
              // of them while there's no result, are shown as plain images.
              const [chartViz, ...otherVisualizations] = queryVisualizations;
              const standaloneVisualizations =
                queryResult != null ? otherVisualizations : queryVisualizations;

              return (
                <div key={key} className="flex flex-col gap-2">
                  <Card className="px-4 py-3 text-xs overflow-hidden shadow-none">
                    <details>
                      <summary className="cursor-pointer select-none font-medium">
                        {att.query?.title ?? "SQL Query"}
                      </summary>
                      <div className="mt-2 flex flex-col gap-1">
                        {att.query?.description && (
                          <span className="text-muted-foreground">
                            {att.query.description}
                          </span>
                        )}
                        {att.query?.query && (
                          <pre className="mt-1 p-2 rounded bg-background text-[11px] whitespace-pre-wrap break-all">
                            {att.query.query}
                          </pre>
                        )}
                      </div>
                    </details>
                  </Card>
                  {queryResult != null && (
                    <Card className="w-full px-4 py-3 overflow-hidden">
                      <GenieQueryVisualization
                        data={queryResult}
                        chartImageUrl={chartViz?.url}
                        chartImageAlt={chartViz?.title}
                      />
                    </Card>
                  )}
                  {standaloneVisualizations.map((viz) => (
                    <GenieVisualizationImage key={viz.url} viz={viz} />
                  ))}
                </div>
              );
            })}
          </div>
        )}

        {unmatchedVisualizations.map((viz) => (
          <GenieVisualizationImage key={viz.url} viz={viz} />
        ))}
      </div>
    </div>
  );
}
