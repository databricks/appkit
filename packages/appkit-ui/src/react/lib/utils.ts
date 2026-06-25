import { type ClassValue, clsx } from "clsx";
import type { Ref } from "react";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Combine multiple refs (callback or object) into one ref callback. Lets a
 * component attach its own internal ref alongside a caller-supplied `ref`
 * without clobbering either.
 */
export function mergeRefs<T>(
  ...refs: (Ref<T> | undefined)[]
): (node: T) => void {
  return (node: T) => {
    for (const ref of refs) {
      if (!ref) continue;
      if (typeof ref === "function") {
        ref(node);
      } else {
        (ref as { current: T | null }).current = node;
      }
    }
  };
}
