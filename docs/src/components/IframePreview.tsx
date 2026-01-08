import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import useBaseUrl from "@docusaurus/useBaseUrl";
import { PortalContainerProvider } from "../../../packages/appkit-ui/src/react/portal-container-context";

interface IframePreviewProps {
  children: React.ReactNode;
}

export function IframePreview({ children }: IframePreviewProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [iframeBody, setIframeBody] = useState<HTMLElement | null>(null);
  const [iframeHeight, setIframeHeight] = useState<number>(200);
  const [stylesLoaded, setStylesLoaded] = useState(false);
  const stylesHref = useBaseUrl("/appkit-ui/styles.css");

  // Initialize iframe document
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    const iframeDoc = iframe.contentDocument;
    if (!iframeDoc) return;

    console.log("[IframePreview] Initializing iframe document");

    // Set up basic HTML structure
    iframeDoc.open();
    iframeDoc.write(`
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <link rel="stylesheet" href="${stylesHref}">
          <style>
            body {
              margin: 0;
              padding: 16px;
              overflow: hidden;
              min-height: 100vh;
            }
            #preview-root {
              display: flex;
              align-items: center;
              justify-content: center;
              min-height: 100px;
            }
          </style>
        </head>
        <body>
          <div id="preview-root"></div>
        </body>
      </html>
    `);
    iframeDoc.close();

    // Wait for styles to load
    const link = iframeDoc.querySelector('link[rel="stylesheet"]');
    if (link) {
      link.addEventListener("load", () => {
        console.log("[IframePreview] Stylesheet loaded");
        setStylesLoaded(true);
        const root = iframeDoc.getElementById("preview-root");
        setIframeBody(root);
      });

      link.addEventListener("error", (e) => {
        console.error("[IframePreview] Failed to load stylesheet", e);
        // Still try to show content even if styles fail
        const root = iframeDoc.getElementById("preview-root");
        setIframeBody(root);
      });
    } else {
      // Fallback if link not found
      const root = iframeDoc.getElementById("preview-root");
      setIframeBody(root);
    }
  }, [stylesHref]);

  // Sync dark mode with parent document
  useEffect(() => {
    if (!iframeRef.current?.contentDocument) return;

    const iframeDoc = iframeRef.current.contentDocument;
    const parentHtml = document.documentElement;

    // Initial sync
    const isDark = parentHtml.getAttribute("data-theme") === "dark";
    iframeDoc.documentElement.classList.toggle("dark", isDark);

    console.log("[IframePreview] Initial dark mode sync:", isDark);

    // Watch for theme changes
    const observer = new MutationObserver(() => {
      const isDark = parentHtml.getAttribute("data-theme") === "dark";
      iframeDoc.documentElement.classList.toggle("dark", isDark);
      console.log("[IframePreview] Dark mode changed:", isDark);
    });

    observer.observe(parentHtml, {
      attributes: true,
      attributeFilter: ["data-theme", "class"],
    });

    return () => observer.disconnect();
  }, [iframeBody]);

  // Auto-resize iframe based on content
  useEffect(() => {
    if (!iframeBody) return;

    const iframe = iframeRef.current;
    if (!iframe?.contentWindow) return;

    console.log("[IframePreview] Setting up ResizeObserver");

    const updateHeight = () => {
      const doc = iframe.contentDocument;
      if (!doc) return;

      // Get full scroll height including portals
      const height = Math.max(
        doc.body.scrollHeight,
        doc.documentElement.scrollHeight,
        doc.body.offsetHeight,
        doc.documentElement.offsetHeight
      );

      // Add padding buffer to prevent scrollbars
      const newHeight = height + 32;
      if (Math.abs(newHeight - iframeHeight) > 5) {
        // Only update if change is significant
        setIframeHeight(newHeight);
        console.log("[IframePreview] Height updated:", newHeight);
      }
    };

    const resizeObserver = new ResizeObserver(() => {
      updateHeight();
    });

    // Observe the preview root
    resizeObserver.observe(iframeBody);

    // Also observe document.body for portal content
    if (iframe.contentDocument?.body) {
      resizeObserver.observe(iframe.contentDocument.body);
    }

    // Initial height calculation
    updateHeight();

    // Also listen to window resize in iframe
    const handleResize = () => updateHeight();
    iframe.contentWindow.addEventListener("resize", handleResize);

    return () => {
      resizeObserver.disconnect();
      iframe.contentWindow?.removeEventListener("resize", handleResize);
    };
  }, [iframeBody, iframeHeight]);

  return (
    <iframe
      ref={iframeRef}
      style={{
        width: "100%",
        height: `${iframeHeight}px`,
        border: "none",
        display: "block",
        backgroundColor: "transparent",
      }}
      title="Component Preview"
    >
      {iframeBody &&
        createPortal(
          <PortalContainerProvider
            container={
              iframeRef.current?.contentDocument?.body ?? null
            }
          >
            {children}
          </PortalContainerProvider>,
          iframeBody
        )}
    </iframe>
  );
}
