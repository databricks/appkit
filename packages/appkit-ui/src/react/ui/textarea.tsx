"use client";

import type * as React from "react";

import { useAgentElement } from "../agent-tools";
import { cn, mergeRefs } from "../lib/utils";

/** Multi-line text input field */
function Textarea({
  className,
  agentId,
  ref,
  ...props
}: React.ComponentProps<"textarea"> & {
  /**
   * Stable id the agent uses to target this textarea via the `set_value`
   * tool. Omit to auto-derive one from the placeholder/name. Only effective
   * inside an `<AgentToolsProvider>`.
   */
  agentId?: string;
}) {
  const agentRef = useAgentElement<HTMLTextAreaElement>({
    role: "textarea",
    agentId,
  });
  return (
    <textarea
      data-slot="textarea"
      ref={mergeRefs(ref, agentRef)}
      className={cn(
        "border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:bg-input/30 flex field-sizing-content min-h-16 w-full rounded-md border bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
