import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import CodeBlock from "@theme/CodeBlock";
import {
  examples,
  type AppKitExampleKey,
} from "../../../packages/appkit-ui/src/react/ui/examples";

import { createPortal } from "react-dom";
import useBaseUrl from "@docusaurus/useBaseUrl";

interface DocExampleProps {
  name: AppKitExampleKey;
}

/**
 * NEW APPROACH:
 * - Let portals (AlertDialog, ContextMenu, etc.) render naturally to document.body
 * - Load AppKit UI styles globally in <head> so portals get styled
 * - Keep shadow DOM only for the main preview container (non-portal content)
 * - This works WITH React's reconciliation instead of fighting it
 */

/**
 * H1-GLOBAL: Load AppKit UI styles globally for portal components
 * This ensures portals that render to document.body are properly styled
 */
function useGlobalAppKitStyles(stylesHref: string) {
  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    console.log("[H1-GLOBAL] Loading global AppKit UI styles for portals", {
      href: stylesHref,
    });

    // Check if global styles are already loaded
    let link = document.head.querySelector(
      "link[data-appkit-global]"
    ) as HTMLLinkElement | null;

    if (!link) {
      console.log("[H1-GLOBAL] Creating new global stylesheet link");
      link = document.createElement("link");
      link.rel = "stylesheet";
      link.setAttribute("data-appkit-global", "");
      document.head.appendChild(link);
    } else {
      console.log("[H1-GLOBAL] Global stylesheet link already exists");
    }

    link.href = stylesHref;

    link.addEventListener("load", () => {
      console.log("[H1-GLOBAL] Global stylesheet loaded successfully");
    });

    link.addEventListener("error", (e) => {
      console.error("[H1-GLOBAL] Failed to load global stylesheet", e);
    });

    return () => {
      // Keep global styles loaded - they're shared across all examples
      console.log("[H1-GLOBAL] Component unmounting (keeping global styles)");
    };
  }, [stylesHref]);
}

/**
 * H3-SHADOW: Initialize shadow DOM for the preview container
 * This isolates the main component styles while allowing portals to escape
 */
function useShadowRoot(
  hostRef: React.RefObject<HTMLDivElement>,
  stylesHref: string
) {
  const [shadowRoot, setShadowRoot] = useState<ShadowRoot | null>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || typeof document === "undefined") {
      return;
    }

    console.log("[H3-SHADOW] Initializing shadow root for preview container");

    let root = host.shadowRoot;
    if (!root) {
      root = host.attachShadow({ mode: "open" });
      console.log("[H3-SHADOW] Created new shadow root");
    } else {
      console.log("[H3-SHADOW] Using existing shadow root");
    }

    // Load styles in shadow DOM for the preview container
    let link = root.querySelector(
      "link[data-appkit-shadow]"
    ) as HTMLLinkElement | null;
    if (!link) {
      console.log("[H3-SHADOW] Creating stylesheet link in shadow DOM");
      link = document.createElement("link");
      link.rel = "stylesheet";
      link.setAttribute("data-appkit-shadow", "");
      root.appendChild(link);
    }

    link.href = stylesHref;

    link.addEventListener("load", () => {
      console.log("[H3-SHADOW] Shadow DOM stylesheet loaded");
    });

    link.addEventListener("error", (e) => {
      console.error("[H3-SHADOW] Failed to load shadow DOM stylesheet", e);
    });

    // Create portal container for React
    let portalContainer = root.querySelector(
      "div[data-portal-container]"
    ) as HTMLDivElement | null;
    if (!portalContainer) {
      console.log("[H3-SHADOW] Creating portal container in shadow DOM");
      portalContainer = document.createElement("div");
      portalContainer.setAttribute("data-portal-container", "");
      root.appendChild(portalContainer);
    }

    setShadowRoot(root);

    return () => {
      console.log("[H3-SHADOW] Cleaning up shadow root");
      if (host.shadowRoot === root) {
        host.innerHTML = "";
      }
    };
  }, [stylesHref]);

  return shadowRoot;
}

export function DocExample({ name }: DocExampleProps) {
  const example = examples[name];
  if (!example) {
    return null;
  }

  const ExampleComponent = example.Component;
  const previewHostRef = useRef<HTMLDivElement>(null);
  const baseStylesHref = useBaseUrl("/appkit-ui/styles.css");
  const [stylesHref, setStylesHref] = useState(baseStylesHref);

  // H1-GLOBAL: Load global styles for portals
  useGlobalAppKitStyles(stylesHref);

  // H3-SHADOW: Initialize shadow DOM for preview container
  const shadowRoot = useShadowRoot(previewHostRef, stylesHref);

  // Resolve the correct styles href based on base tag
  useLayoutEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    const baseElement = document.querySelector("base");
    const baseHref = baseElement?.getAttribute("href");
    if (!baseHref) {
      return;
    }

    const origin = window.location.origin;
    const prefix = baseHref.startsWith("http")
      ? baseHref
      : `${origin}${baseHref}`;
    try {
      const resolved = new URL("appkit-ui/styles.css", prefix);
      setStylesHref((current) =>
        current === resolved.pathname ? current : resolved.pathname
      );
    } catch {
      // fall back to the baseStylesHref already set
    }
  }, [baseStylesHref]);

  return (
    <section className="doc-example">
      <div className="doc-example-preview" ref={previewHostRef}>
        {shadowRoot &&
          createPortal(
            <div className="doc-example-preview-contents">
              <ExampleComponent />
            </div>,
            shadowRoot.querySelector("div[data-portal-container]") as Element
          )}
      </div>
      <div className="doc-example-source">
        <CodeBlock language="tsx">{example.source}</CodeBlock>
      </div>
    </section>
  );
}

