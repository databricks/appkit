import type * as React from "react";

/** Props for a single {@link Variant} inside a {@link Variants} block. */
export interface VariantProps {
  /** Human-readable label shown in the switcher and recorded on confirm. */
  label?: string;
  children: React.ReactNode;
}

/**
 * One candidate inside a {@link Variants} block. Purely a declarative marker:
 * `Variants` reads its `label` and renders its `children` for the active
 * index. It is not meant to be rendered on its own.
 */
export function Variant({ children }: VariantProps) {
  return <>{children}</>;
}
