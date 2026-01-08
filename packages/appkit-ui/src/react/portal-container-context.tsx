import type React from "react";
import { createContext, useContext } from "react";

/**
 * Context for providing a custom portal container.
 * This is used when rendering components in isolated contexts like iframes or shadow DOM.
 * Portal components (AlertDialog, ContextMenu, etc.) will use this container instead of document.body
 */
export const PortalContainerContext = createContext<HTMLElement | null>(null);

export function usePortalContainer() {
  return useContext(PortalContainerContext);
}

/**
 * Resolves the final portal container from explicit prop or context.
 *
 * This hook enables Portal components to work seamlessly in isolated rendering contexts
 * (like iframes, shadow DOM, or isolated component previews) by accepting a container
 * from either:
 * 1. An explicit `container` prop (highest priority)
 * 2. A `PortalContainerProvider` context (fallback)
 * 3. undefined (lets Radix UI use document.body as default)
 *
 * @param containerProp - Optional explicit container element from props
 * @returns The resolved container element to use for portal rendering
 *
 * @example
 * ```tsx
 * function MyPortal({ container, ...props }) {
 *   return (
 *     <RadixPortal container={useResolvedPortalContainer(container)} {...props}>
 *       <MyContent />
 *     </RadixPortal>
 *   );
 * }
 * ```
 */
export function useResolvedPortalContainer(
  containerProp?: Element | DocumentFragment | HTMLElement | null | undefined,
): Element | DocumentFragment | HTMLElement | null | undefined {
  const containerFromContext = usePortalContainer();
  return containerProp ?? containerFromContext ?? undefined;
}

interface PortalContainerProviderProps {
  container: HTMLElement | null;
  children: React.ReactNode;
}

export function PortalContainerProvider({
  container,
  children,
}: PortalContainerProviderProps) {
  return (
    <PortalContainerContext.Provider value={container}>
      {children}
    </PortalContainerContext.Provider>
  );
}
