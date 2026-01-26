"use client";

import * as AspectRatioPrimitive from "@radix-ui/react-aspect-ratio";

/** Container that maintains a specific aspect ratio for its content */
function AspectRatio({
  ...props
}: React.ComponentProps<typeof AspectRatioPrimitive.Root>) {
  return <AspectRatioPrimitive.Root data-slot="aspect-ratio" {...props} />;
}

export { AspectRatio };
