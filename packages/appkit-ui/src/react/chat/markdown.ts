import { marked } from "marked";
import { cn } from "../lib/utils";

/**
 * Using `marked` instead of `react-markdown` because `react-markdown` depends on
 * `micromark-util-symbol` which has broken ESM exports with `rolldown-vite`.
 * Content comes from our own APIs so `dangerouslySetInnerHTML` is safe.
 */
marked.setOptions({ breaks: true, gfm: true });

export { marked };

export const markdownStyles = cn(
  "text-sm break-words",
  "[&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0",
  "[&_pre]:bg-background/50 [&_pre]:p-2 [&_pre]:rounded [&_pre]:text-xs [&_pre]:overflow-x-auto",
  "[&_code]:text-xs [&_code]:bg-background/50 [&_code]:px-1 [&_code]:rounded",
  "[&_table]:text-xs [&_th]:px-2 [&_th]:py-1 [&_td]:px-2 [&_td]:py-1",
  "[&_table]:border-collapse [&_th]:border [&_td]:border",
  "[&_th]:border-border [&_td]:border-border",
  "[&_a]:underline",
);
