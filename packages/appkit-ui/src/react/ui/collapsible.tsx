"use client";

import * as CollapsiblePrimitive from "@radix-ui/react-collapsible";
import type * as React from "react";

import { useAgentElement } from "../agent-tools";
import { mergeRefs } from "../lib/utils";

/** Interactive component that expands and collapses content */
function Collapsible({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.Root>) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;
}

/** Button that toggles the collapsible content visibility */
function CollapsibleTrigger({
  agentId,
  ref,
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleTrigger> & {
  /** Stable id the agent uses to open/close via `open`/`close`/`toggle`. */
  agentId?: string;
}) {
  const agentRef = useAgentElement<HTMLButtonElement>({
    role: "disclosure",
    agentId,
  });
  return (
    <CollapsiblePrimitive.CollapsibleTrigger
      data-slot="collapsible-trigger"
      ref={mergeRefs(ref, agentRef)}
      {...props}
    />
  );
}

/** Content area that can be expanded or collapsed */
function CollapsibleContent({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent>) {
  return (
    <CollapsiblePrimitive.CollapsibleContent
      data-slot="collapsible-content"
      {...props}
    />
  );
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
