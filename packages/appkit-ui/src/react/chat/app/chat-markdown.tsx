import DOMPurify from "dompurify";
import { marked } from "marked";
import { useMemo } from "react";
import { cn } from "../../lib/utils";

const MARKED_OPTIONS = { breaks: true, gfm: true, async: false } as const;

const markdownStyles = cn(
  "text-base wrap-break-word",
  "[&_p]:my-1 [&_ul]:my-4 [&_ul]:pl-6 [&_ul]:list-disc [&_ol]:my-4 [&_ol]:pl-6 [&_ol]:list-decimal [&_li]:my-0",
  "[&_h1]:text-xl [&_h1]:font-semibold [&_h1]:mt-4 [&_h1]:mb-2",
  "[&_h2]:text-lg [&_h2]:font-semibold [&_h2]:mt-4 [&_h2]:mb-2",
  "[&_h3]:text-base [&_h3]:font-semibold [&_h3]:mt-3 [&_h3]:mb-1",
  "[&_pre]:bg-muted [&_pre]:p-3 [&_pre]:rounded-md [&_pre]:text-xs [&_pre]:overflow-x-auto [&_pre]:my-2",
  "[&_code]:text-xs [&_code]:bg-muted [&_code]:px-1 [&_code]:rounded",
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
  "[&_table]:text-xs [&_table]:block [&_table]:overflow-x-auto [&_table]:max-w-full [&_table]:my-2",
  "[&_th]:px-2 [&_th]:py-1 [&_td]:px-2 [&_td]:py-1",
  "[&_table]:border-collapse [&_th]:border [&_td]:border",
  "[&_th]:border-border [&_td]:border-border",
  "[&_a]:text-primary [&_a]:underline [&_a:hover]:no-underline",
  "[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground",
);

interface MarkdownProps {
  children: string;
  className?: string;
}

/** Markdown renderer: `marked` → DOMPurify → `dangerouslySetInnerHTML`. */
export function ChatMarkdown({ children, className }: MarkdownProps) {
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(children, MARKED_OPTIONS)),
    [children],
  );
  return (
    <div
      className={cn(markdownStyles, className)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
