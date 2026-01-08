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
            html, body {
              margin: 0;
              padding: 0;
              height: 100%;
              overflow: auto;
            }
            body {
              padding: 16px;
            }
            #preview-root {
              display: flex;
              align-items: center;
              justify-content: center;
              min-height: 200px;
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

  // No auto-resize needed - iframe has fixed height with internal scrolling

  return (
    <iframe
      ref={iframeRef}
      style={{
        width: "100%",
        height: "400px",
        minHeight: "200px",
        maxHeight: "600px",
        border: "none",
        display: "block",
        backgroundColor: "transparent",
        borderRadius: "8px",
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
