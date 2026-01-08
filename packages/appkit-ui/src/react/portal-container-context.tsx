import React, { createContext, useContext } from "react";

/**
 * Context for providing a custom portal container.
 * This is used when rendering components in isolated contexts like iframes or shadow DOM.
 * Portal components (AlertDialog, ContextMenu, etc.) will use this container instead of document.body
 */
export const PortalContainerContext = createContext<HTMLElement | null>(null);

export function usePortalContainer() {
  return useContext(PortalContainerContext);
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
