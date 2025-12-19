"use client";

import type * as React from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { CheckIcon } from "lucide-react";

import { cn } from "../lib/utils";

function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        // Fixed size and square shape - IMPORTANT: overrides global CSS
        "h-4 w-4 p-0 m-0 shrink-0 flex-shrink-0",
        // Base appearance
        "peer border-input dark:bg-input/30 rounded-[4px] border shadow-xs",
        // Checked states
        "data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground dark:data-[state=checked]:bg-primary data-[state=checked]:border-primary",
        // Focus states
        "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] outline-none",
        // Error states
        "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
        // Disabled states
        "disabled:cursor-not-allowed disabled:opacity-50",
        // Transitions
        "transition-shadow",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid place-content-center text-current transition-none"
      >
        <CheckIcon className="size-3.5" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
